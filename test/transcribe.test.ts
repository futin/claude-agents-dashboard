import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../server/lib/config.js';
import {
  buildFfmpegArgs, buildWhisperArgs, extForMime, parseOutput
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

export function run(): number {
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

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
