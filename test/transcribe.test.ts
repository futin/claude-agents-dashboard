import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../server/lib/config.js';
import {
  buildFfmpegArgs, buildWhisperArgs, extForMime, parseOutput, probeTranscribe, resetProbe, transcribe
} from '../server/lib/transcribe.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Write a throwaway .env and load config from it. */
function withEnvFile(body: string, fn: (cfg: ReturnType<typeof loadConfig>) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-tr-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, body);
  try { fn(loadConfig({ envPath })); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** A throwaway executable that exits 0 and prints nothing. */
function stubBin(dir: string, name: string, body = '#!/bin/bash\nexit 0\n'): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export async function run(): Promise<number> {
  console.log('\n=== transcribe.ts ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(test('config defaults leave the feature off', () => {
    withEnvFile('', cfg => {
      assert.equal(cfg.whisperModel, '');
      assert.equal(cfg.whisperBin, 'whisper-cli');
      assert.equal(cfg.ffmpegBin, 'ffmpeg');
    });
  }));

  check(test('config reads all three keys from .env', () => {
    withEnvFile('WHISPER_MODEL=/m/base.bin\nWHISPER_BIN=/opt/w\nFFMPEG_BIN=/opt/ff\n', cfg => {
      assert.equal(cfg.whisperModel, '/m/base.bin');
      assert.equal(cfg.whisperBin, '/opt/w');
      assert.equal(cfg.ffmpegBin, '/opt/ff');
    });
  }));

  check(test('extForMime maps the recorder types, codecs suffix and all', () => {
    assert.equal(extForMime('audio/mp4'), 'm4a');
    assert.equal(extForMime('audio/webm;codecs=opus'), 'webm');
    assert.equal(extForMime('AUDIO/WAV'), 'wav');
    assert.equal(extForMime('audio/ogg'), 'ogg');
    assert.equal(extForMime('audio/mpeg'), 'mp3');
  }));

  check(test('extForMime rejects anything unlisted', () => {
    assert.equal(extForMime('video/mp4'), null);
    assert.equal(extForMime('application/json'), null);
    assert.equal(extForMime(''), null);
  }));

  check(test('buildFfmpegArgs downmixes to 16kHz mono, overwriting', () => {
    assert.deepEqual(buildFfmpegArgs('/t/in.m4a', '/t/out.wav'), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', '/t/in.m4a', '-ar', '16000', '-ac', '1', '/t/out.wav'
    ]);
  }));

  check(test('buildWhisperArgs asks for untimestamped text', () => {
    assert.deepEqual(buildWhisperArgs('/m/base.bin', '/t/out.wav'),
      ['-m', '/m/base.bin', '-f', '/t/out.wav', '-nt']);
  }));

  check(test('parseOutput strips timestamps and joins lines', () => {
    const raw = '[00:00:00.000 --> 00:00:02.400]   Hello there\n'
              + '[00:00:02.400 --> 00:00:04.000]   second line\n';
    assert.equal(parseOutput(raw), 'Hello there second line');
  }));

  check(test('parseOutput treats blank-audio markers as no speech', () => {
    assert.equal(parseOutput('[BLANK_AUDIO]\n'), '');
    assert.equal(parseOutput('  \n\n'), '');
    assert.equal(parseOutput('(silence)'), '');
  }));

  check(test('probe is false with no model configured', () => {
    resetProbe();
    withEnvFile('', cfg => assert.equal(probeTranscribe(cfg), false));
  }));

  check(test('probe is false when the model file is missing', () => {
    resetProbe();
    withEnvFile('WHISPER_MODEL=/nope/missing.bin\n', cfg =>
      assert.equal(probeTranscribe(cfg), false));
  }));

  check(test('probe is true with a real model file and a runnable binary', () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-probe-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const bin = stubBin(dir, 'whisper-stub');
      withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${bin}\n`, cfg =>
        assert.equal(probeTranscribe(cfg), true));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(test('probe is false when the binary does not exist', () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-probe2-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${path.join(dir, 'nothing-here')}\n`, cfg =>
        assert.equal(probeTranscribe(cfg), false));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(test('probe caches — a later config change is not re-read', () => {
    resetProbe();
    withEnvFile('', cfg => assert.equal(probeTranscribe(cfg), false));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-probe3-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const bin = stubBin(dir, 'whisper-stub');
      // Same process, no resetProbe(): the cached `false` must win.
      withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${bin}\n`, cfg =>
        assert.equal(probeTranscribe(cfg), false));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    resetProbe();
  }));

  check(await testAsync('transcribe returns parsed text from the stubbed engine', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-run-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      // ffmpeg stub: create the output file (always the last argument).
      const ff = stubBin(dir, 'ff-stub', '#!/bin/bash\nout="${@: -1}"\n: > "$out"\nexit 0\n');
      const wh = stubBin(dir, 'wh-stub',
        '#!/bin/bash\necho "[00:00:00.000 --> 00:00:01.500]   spoken words"\nexit 0\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          void transcribe(cfg, Buffer.from('fake-audio'), 'm4a').then(out => {
            assert.deepEqual(out, { ok: true, text: 'spoken words' });
            done();
          });
        });
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('a failing ffmpeg reports transcode, not engine', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-run2-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const ff = stubBin(dir, 'ff-bad', '#!/bin/bash\nexit 1\n');
      const wh = stubBin(dir, 'wh-stub', '#!/bin/bash\necho hi\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          void transcribe(cfg, Buffer.from('fake'), 'm4a').then(out => {
            assert.deepEqual(out, { ok: false, reason: 'transcode' });
            done();
          });
        });
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('a second concurrent call is refused as busy', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-run3-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const ff = stubBin(dir, 'ff-slow', '#!/bin/bash\nsleep 0.4\nout="${@: -1}"\n: > "$out"\n');
      const wh = stubBin(dir, 'wh-stub', '#!/bin/bash\necho "first"\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          const a = transcribe(cfg, Buffer.from('fake'), 'm4a');
          const b = transcribe(cfg, Buffer.from('fake'), 'm4a');
          void Promise.all([a, b]).then(([first, second]) => {
            assert.deepEqual(second, { ok: false, reason: 'busy' });
            assert.equal(first.ok, true);
            done();
          });
        });
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('the temp directory is removed afterwards', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-run4-'));
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cad-dictate-')).length;
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const ff = stubBin(dir, 'ff-stub', '#!/bin/bash\nout="${@: -1}"\n: > "$out"\n');
      const wh = stubBin(dir, 'wh-stub', '#!/bin/bash\necho "words"\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          void transcribe(cfg, Buffer.from('fake'), 'm4a').then(() => {
            const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cad-dictate-')).length;
            assert.equal(after, before);
            done();
          });
        });
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
