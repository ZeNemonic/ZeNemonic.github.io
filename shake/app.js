// handled here:
//   sensor capture
//   touch gate
//   UI
//   recording

const $ = (s) => document.querySelector(s);
const pad = $('#pad'), hint = $('#hint'), status = $('#status');

let ctx = null, node = null, out = null;
let started = false, sensorKind = null, simMode = false;
let gate = false, touches = 0, meter = 0;
let recording = null; // array of rows while recording
const last = { x: 0, y: 9.81, z: 0 };

function post(msg) { node && node.port.postMessage(msg); }

function feed(x, y, z) {
  last.x = x; last.y = y; last.z = z;
  post({ type: 'accel', x, y, z });
  if (recording) recording.push([performance.now().toFixed(1), x.toFixed(4), y.toFixed(4), z.toFixed(4), gate ? 1 : 0]);
}

function setGate(on) {
  if (gate === on) return;
  gate = on;
  post({ type: 'gate', on });
  pad.classList.toggle('held', on);
}

//// sensors ////

async function startGenericSensor() {
  if (!('Accelerometer' in window)) return false;
  try {
    const perm = await navigator.permissions?.query({ name: 'accelerometer' }).catch(() => null);
    if (perm && perm.state === 'denied') return false;
    const s = new Accelerometer({ frequency: 60 }); // includes gravity, which is what the model wants
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('no readings')), 1500);
      s.onreading = () => { clearTimeout(t); res(); };
      s.onerror = (e) => { clearTimeout(t); rej(e.error); };
      s.start();
    });
    s.onreading = () => feed(s.x, s.y, s.z);
    s.onerror = (e) => console.warn('sensor error', e.error);
    return true;
  } catch (e) { console.warn('Generic Sensor unavailable:', e); return false; }
}

async function startDeviceMotion(permission) {
  if (!('DeviceMotionEvent' in window) || permission !== 'granted') return false;
  const ok = await new Promise((res) => {
    const probe = (e) => {
      const a = e.accelerationIncludingGravity;
      if (a && a.x != null) { removeEventListener('devicemotion', probe); clearTimeout(t); res(true); }
    };
    const t = setTimeout(() => { removeEventListener('devicemotion', probe); res(false); }, 1500);
    addEventListener('devicemotion', probe);
  });
  if (!ok) return false;
  addEventListener('devicemotion', (e) => {
    const a = e.accelerationIncludingGravity;
    if (a && a.x != null) feed(a.x, a.y, a.z);
  });
  return true;
}

// desktop fallback for testing with ponter
function startPointerSim() {
  simMode = true;
  const PX_TO_M = 0.0006;
  let pos = null, prev = null, vPrev = { x: 0, y: 0 }, tPrev = performance.now();
  const sm = { x: 0, y: 0 };
  pad.addEventListener('pointermove', (e) => { pos = { x: e.clientX, y: e.clientY }; });
  const tick = (t) => {
    const dt = Math.max(1e-3, (t - tPrev) / 1000); tPrev = t;
    let ax = 0, ay = 0;
    if (pos && prev) {
      const v = { x: (pos.x - prev.x) * PX_TO_M / dt, y: -(pos.y - prev.y) * PX_TO_M / dt };
      ax = (v.x - vPrev.x) / dt; ay = (v.y - vPrev.y) / dt;
      vPrev = v;
    }
    prev = pos && { ...pos };
    sm.x += (ax - sm.x) * 0.5; sm.y += (ay - sm.y) * 0.5;
    feed(sm.x, sm.y + 9.81, 0); // specific force = a + (0, g, 0) when held upright
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

//// startup ////

async function start() {
  if (started) return;
  started = true;
  hint.textContent = 'Starting…';

  // Both of these must begin synchronously inside the user gesture (iOS).
  const permP = (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')
    ? DeviceMotionEvent.requestPermission().catch(() => 'denied')
    : Promise.resolve('granted');
  ctx = new AudioContext({ latencyHint: 'interactive' });
  ctx.resume();

  try {
    await ctx.audioWorklet.addModule('shaker-worklet.js');
    node = new AudioWorkletNode(ctx, 'shaker', { numberOfInputs: 0, outputChannelCount: [2] });
    out = ctx.createGain();
    out.gain.value = +$('#vol').value;
    node.connect(out).connect(ctx.destination);
    node.port.onmessage = (e) => { if (e.data.type === 'meter') meter = e.data.energy; };
    post({ type: 'preset', name: $('#preset').value });
    post({ type: 'sens', value: +$('#sens').value });
    post({ type: 'drive', value: +$('#drive').value });
  } catch (e) {
    hint.textContent = 'Audio failed: ' + e.message;
    started = false;
    return;
  }

  const permission = await permP;
  if (await startGenericSensor()) sensorKind = 'Generic Sensor API';
  else if (await startDeviceMotion(permission)) sensorKind = 'DeviceMotion';
  else { sensorKind = 'pointer simulation (no motion sensor)'; startPointerSim(); }

  try { await navigator.wakeLock?.request('screen'); } catch {}
  hint.textContent = simMode ? 'Hold and drag to shake' : 'Hold to grip · move to shake';
  requestAnimationFrame(draw);
}

//// touch gate ////
pad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!started) { start(); return; }
  pad.setPointerCapture(e.pointerId);
  touches++;
  setGate(true);
});
const release = (e) => {
  if (!started) return;
  touches = Math.max(0, touches - 1);
  if (touches === 0) setGate(false);
};
pad.addEventListener('pointerup', release);
pad.addEventListener('pointercancel', release);
pad.addEventListener('contextmenu', (e) => e.preventDefault());

//// controls ////

$('#preset').addEventListener('change', (e) => post({ type: 'preset', name: e.target.value }));
$('#sens').addEventListener('input', (e) => post({ type: 'sens', value: +e.target.value }));
$('#drive').addEventListener('input', (e) => post({ type: 'drive', value: +e.target.value }));
$('#vol').addEventListener('input', (e) => { if (out) out.gain.value = +e.target.value; });

$('#rec').addEventListener('click', () => {
  const btn = $('#rec');
  if (!recording) {
    recording = [];
    btn.textContent = '■ Stop';
    btn.classList.add('on');
    return;
  }
  const rows = recording; recording = null;
  btn.textContent = '● Rec';
  btn.classList.remove('on');
  const meta = `# sensor=${sensorKind}; preset=${$('#preset').value}; ua=${navigator.userAgent}\n`;
  const csv = meta + 't_ms,fx,fy,fz,gate\n' + rows.map((r) => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `shake-${$('#preset').value}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

//// display ////

function draw() {
  const glow = Math.min(1, meter * 1.5);
  pad.style.setProperty('--glow', glow.toFixed(3));
  const mag = Math.hypot(last.x, last.y, last.z);
  status.textContent = `${sensorKind} · |f| ${mag.toFixed(1)} m/s² · ${gate ? 'GRIP' : 'muted'}${recording ? ` · rec ${recording.length}` : ''}`;
  requestAnimationFrame(draw);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
