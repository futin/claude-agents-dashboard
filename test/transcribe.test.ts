import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../server/lib/config.js';
import {
  buildFfmpegArgs, buildWhisperArgs, extForMime, parseOutput, probeTranscribe, resetProbe, transcribe
} from '../server/lib/transcribe.js';
import { resetState } from '../server/lib/remoteState.js';
import { readBinaryBody, serveTranscribe } from '../server/api.js';

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

/**
 * Run an endpoint test in isolation: tmpdir cwd + a fresh remote-state cache,
 * so `getState()` can't see (or write) the repo's real gitignored
 * .remote-answer.json, and a stale in-process `cached` left by an earlier
 * test/suite can't leak in either. Mirrors `test/notify.test.ts`'s `inTmpCwd`.
 */
async function inTmpCwd(fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-ep-cwd-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    resetState();
    await fn();
  } finally {
    process.chdir(prev);
    resetState();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * POST a body to a one-shot server wrapping `serveTranscribe`, return the
 * reply. `contentLength`, when given, overrides the header Node would
 * otherwise compute from `body` — how the Content-Length-pre-check test sends
 * a declared size the actual body doesn't match.
 *
 * `settle` guarantees `srv.close()` runs exactly once on every path (success,
 * a request/response/server error) and that the promise itself only ever
 * settles once — a bare `http.request` has no default `'error'` listener, so
 * without this a socket-level failure becomes an unhandled throw that kills
 * the whole `pnpm test` process instead of failing just this one case.
 */
function post(
  cfg: ReturnType<typeof loadConfig>, contentType: string, body: Buffer, token?: string, contentLength?: number
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => void serveTranscribe(cfg, req, res));
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      srv.close();
      fn();
    };
    srv.on('error', e => settle(() => reject(e)));
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      const headers: Record<string, string> = { 'Content-Type': contentType };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (contentLength !== undefined) headers['Content-Length'] = String(contentLength);
      const req = http.request({ port, method: 'POST', path: '/api/transcribe', headers }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          const json = (() => { try { return JSON.parse(raw); } catch { return null; } })();
          settle(() => resolve({ status: res.statusCode || 0, json }));
        });
        res.on('error', e => settle(() => reject(e)));
      });
      req.on('error', e => settle(() => reject(e)));
      req.end(body);
    });
  });
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
    let err: unknown;
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      // ffmpeg stub: create the output file (always the last argument).
      const ff = stubBin(dir, 'ff-stub', '#!/bin/bash\nout="${@: -1}"\n: > "$out"\nexit 0\n');
      const wh = stubBin(dir, 'wh-stub',
        '#!/bin/bash\necho "[00:00:00.000 --> 00:00:01.500]   spoken words"\nexit 0\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          transcribe(cfg, Buffer.from('fake-audio'), 'm4a')
            .then(out => { assert.deepEqual(out, { ok: true, text: 'spoken words' }); })
            .catch(e => { err = e; })
            .finally(done);
        });
      });
      if (err) throw err;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('a failing ffmpeg reports transcode, not engine', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-run2-'));
    let err: unknown;
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const ff = stubBin(dir, 'ff-bad', '#!/bin/bash\nexit 1\n');
      const wh = stubBin(dir, 'wh-stub', '#!/bin/bash\necho hi\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          transcribe(cfg, Buffer.from('fake'), 'm4a')
            .then(out => { assert.deepEqual(out, { ok: false, reason: 'transcode' }); })
            .catch(e => { err = e; })
            .finally(done);
        });
      });
      if (err) throw err;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('a second concurrent call is refused as busy', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-run3-'));
    let err: unknown;
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const ff = stubBin(dir, 'ff-slow', '#!/bin/bash\nsleep 0.4\nout="${@: -1}"\n: > "$out"\n');
      const wh = stubBin(dir, 'wh-stub', '#!/bin/bash\necho "first"\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          const a = transcribe(cfg, Buffer.from('fake'), 'm4a');
          const b = transcribe(cfg, Buffer.from('fake'), 'm4a');
          Promise.all([a, b])
            .then(([first, second]) => {
              assert.deepEqual(second, { ok: false, reason: 'busy' });
              assert.equal(first.ok, true);
            })
            .catch(e => { err = e; })
            .finally(done);
        });
      });
      if (err) throw err;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('the temp directory is removed afterwards', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-run4-'));
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cad-dictate-')).length;
    let err: unknown;
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const ff = stubBin(dir, 'ff-stub', '#!/bin/bash\nout="${@: -1}"\n: > "$out"\n');
      const wh = stubBin(dir, 'wh-stub', '#!/bin/bash\necho "words"\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          transcribe(cfg, Buffer.from('fake'), 'm4a')
            .then(() => {
              const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cad-dictate-')).length;
              assert.equal(after, before);
            })
            .catch(e => { err = e; })
            .finally(done);
        });
      });
      if (err) throw err;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('404 when no engine is configured', async () => {
    resetProbe();
    let err: unknown;
    await inTmpCwd(async () => {
      await new Promise<void>(done => {
        withEnvFile('', cfg => {
          void post(cfg, 'audio/mp4', Buffer.from('x'))
            .then(r => { assert.equal(r.status, 404); })
            .catch(e => { err = e; })
            .finally(done);
        });
      });
    });
    if (err) throw err;
  }));

  check(await testAsync('403 when the token is wrong', async () => {
    resetProbe();
    let err: unknown;
    await inTmpCwd(async () => {
      await new Promise<void>(done => {
        withEnvFile('ANSWER_TOKEN=secret\n', cfg => {
          void post(cfg, 'audio/mp4', Buffer.from('x'), 'wrong')
            .then(r => { assert.equal(r.status, 403); })
            .catch(e => { err = e; })
            .finally(done);
        });
      });
    });
    if (err) throw err;
  }));

  // `getState()` overlays the gitignored .remote-answer.json in the CWD on top
  // of the env gate, and caches the result for the process — `inTmpCwd` gives
  // this test (and its three siblings above/below) a cwd with no such file and
  // a freshly reset cache, so none of them depend on what the repo's real
  // toggle currently reads or on what an earlier suite left `cached` as.
  check(await testAsync('404 when remote answers are disabled', async () => {
    resetProbe();
    let err: unknown;
    await inTmpCwd(async () => {
      await new Promise<void>(done => {
        withEnvFile('REMOTE_ANSWER=false\n', cfg => {
          void post(cfg, 'audio/mp4', Buffer.from('x'))
            .then(r => { assert.equal(r.status, 404); })
            .catch(e => { err = e; })
            .finally(done);
        });
      });
    });
    if (err) throw err;
  }));

  check(await testAsync('400 names the unsupported content type', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-ep-'));
    let err: unknown;
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const bin = stubBin(dir, 'wh-stub');
      await inTmpCwd(async () => {
        await new Promise<void>(done => {
          withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${bin}\n`, cfg => {
            void post(cfg, 'video/mp4', Buffer.from('x'))
              .then(r => {
                assert.equal(r.status, 400);
                assert.match(String(r.json?.error), /video\/mp4/);
              })
              .catch(e => { err = e; })
              .finally(done);
          });
        });
      });
      if (err) throw err;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('a declared Content-Length over the cap is refused without reading the body', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-ep2-'));
    let err: unknown;
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const bin = stubBin(dir, 'wh-stub');
      await inTmpCwd(async () => {
        await new Promise<void>(done => {
          withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${bin}\n`, cfg => {
            // Declares far more than the 8MB AUDIO_CAP while the actual body
            // is one byte. If the pre-check didn't fire, the server would wait
            // on bytes that never arrive (or report 'aborted' once the client
            // closes) — 413 here proves it rejected on the header alone.
            void post(cfg, 'audio/mp4', Buffer.from('x'), undefined, 8 * 1024 * 1024 + 1)
              .then(r => { assert.equal(r.status, 413); })
              .catch(e => { err = e; })
              .finally(done);
          });
        });
      });
      if (err) throw err;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('readBinaryBody reports overflow distinctly from abort', async () => {
    const srv = http.createServer((req, res) => {
      void readBinaryBody(req, 8).then(out => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.ok ? { ok: true, n: out.bytes.length } : out));
      });
    });
    await new Promise<void>(done => {
      srv.listen(0, () => {
        const port = (srv.address() as { port: number }).port;
        const req = http.request({ port, method: 'POST', path: '/' }, res => {
          let raw = '';
          res.on('data', c => { raw += c; });
          res.on('end', () => {
            srv.close();
            assert.deepEqual(JSON.parse(raw), { ok: false, reason: 'overflow' });
            done();
          });
        });
        req.end(Buffer.alloc(64, 1));
      });
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
