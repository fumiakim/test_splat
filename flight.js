// flight.js — マインクラフトと同じキー操作で、宇宙空間をモデルごと自在に移動する。
//
//   W / S        前進 / 後退（カメラの向きが基準）
//   A / D        左 / 右
//   Space        上昇
//   Shift        下降
//   Ctrl / W×2   加速（W を素早く 2 回押すか、Ctrl を押しながら）
//
// モデルはビューアの中心に置いたまま、まわりの宇宙（パーティクル）のほうを逆向きに流して
// 移動を表す。だからビューアのカメラ操作（ドラッグで回り込む等）は移動中もそのまま使える。
// モデルは進む向きへ体を向け、移動中は前へ 25° ほど傾き、止まると直立に戻る。
// ふくらはぎのスラスターの炎は、推力（キー入力）に合わせて出る。

export const FLIGHT = {
    speed: 3.2, // 移動の速さ（モデルの半径 / 秒）
    sprint: 2.5, // 加速時の倍率
    accel: 2.5, // 速度の追従の速さ（小さいほど慣性が強く、宇宙らしく流れる）
    lean: 25, // 移動中の前傾（度）
    turnRate: 5, // 進む向きへ体を向ける速さ
    leanRate: 4, // 前傾・直立に移る速さ
    doubleTapMs: 300 // W の 2 度押しを加速とみなす間隔
};

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']);
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// quaternions as [x, y, z, w]
const qAxis = (x, y, z, angle) => {
    const s = Math.sin(angle / 2);
    return [x * s, y * s, z * s, Math.cos(angle / 2)];
};
const qMul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
];
// column-major 3x3 rotation matrix of a unit quaternion
const qMat3 = ([x, y, z, w], out) => {
    out[0] = 1 - 2 * (y * y + z * z);
    out[1] = 2 * (x * y + z * w);
    out[2] = 2 * (x * z - y * w);
    out[3] = 2 * (x * y - z * w);
    out[4] = 1 - 2 * (x * x + z * z);
    out[5] = 2 * (y * z + x * w);
    out[6] = 2 * (x * z + y * w);
    out[7] = 2 * (y * z - x * w);
    out[8] = 1 - 2 * (x * x + y * y);
    return out;
};
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const createFlight = () => {
    const pressed = new Set();
    let sprintLatched = false; // from a W double tap, until W is released
    let lastWDown = 0;
    let engaged = false; // the first flight key hands the camera from its animation to the user

    const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    const onKeyDown = (e) => {
        if (!KEYS.has(e.code) || e.metaKey || e.altKey || isTyping(e.target)) return;
        // keep these keys from the viewer: it would switch to first-person on WASD and toggle
        // its camera animation on Space
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.code === 'KeyW' && !e.repeat) {
            const now = performance.now();
            if (now - lastWDown < FLIGHT.doubleTapMs) sprintLatched = true;
            lastWDown = now;
        }
        pressed.add(e.code);
        if (!engaged) {
            engaged = true;
            hint.dismissSoon();
            // stop the viewer's camera animation so "forward" stays put while flying
            const state = window.sseViewer?.state;
            if (state && state.cameraMode === 'anim') state.cameraMode = 'orbit';
        }
    };
    const onKeyUp = (e) => {
        if (!KEYS.has(e.code)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        pressed.delete(e.code);
        if (e.code === 'KeyW') sprintLatched = false;
    };
    const releaseAll = () => {
        pressed.clear();
        sprintLatched = false;
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', releaseAll);

    const hint = createHint();

    const state = {
        offset: [0, 0, 0], // how far the space has moved past the model (model radii)
        vel: [0, 0, 0],
        yaw: 0,
        lean: 0,
        thrust: 0, // 0..1, smoothed key input: drives the flames
        sprint: 0, // 0..1, smoothed
        rotation: [0, 0, 0, 1], // the model's turn and lean
        rotMat: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
    };

    // camForward: the camera's view direction in world space
    const update = (dt, camForward) => {
        const k = (code) => (pressed.has(code) ? 1 : 0);
        const fwd = k('KeyW') - k('KeyS');
        const strafe = k('KeyD') - k('KeyA');
        const rise = k('Space') - Math.max(k('ShiftLeft'), k('ShiftRight'));
        const ctrl = IS_MAC ? Math.max(k('ControlLeft'), k('ControlRight')) : 0; // Ctrl+W closes the tab elsewhere
        const sprinting = (sprintLatched || ctrl) && (fwd || strafe || rise) ? 1 : 0;

        // forward and right along the ground, from where the camera looks
        let fx = camForward[0];
        let fz = camForward[2];
        const fl = Math.hypot(fx, fz) || 1;
        fx /= fl;
        fz /= fl;
        const rx = -fz;
        const rz = fx;
        let ix = fx * fwd + rx * strafe;
        let iy = rise;
        let iz = fz * fwd + rz * strafe;
        const il = Math.hypot(ix, iy, iz);
        if (il > 1) {
            ix /= il;
            iy /= il;
            iz /= il;
        }
        const input = Math.min(1, il);

        state.sprint += (sprinting - state.sprint) * (1 - Math.exp(-dt * 4));
        const top = FLIGHT.speed * (1 + (FLIGHT.sprint - 1) * state.sprint);
        const a = 1 - Math.exp(-dt * FLIGHT.accel);
        state.vel[0] += (ix * top - state.vel[0]) * a;
        state.vel[1] += (iy * top - state.vel[1]) * a;
        state.vel[2] += (iz * top - state.vel[2]) * a;
        // not wrapped here: every particle repeats at its own interval in the shader
        for (let i = 0; i < 3; i++) state.offset[i] += state.vel[i] * dt;
        state.thrust += (input - state.thrust) * (1 - Math.exp(-dt * 8));

        // face where it is going along the ground, lean into it, stand up again when stopping
        const hs = Math.hypot(state.vel[0], state.vel[2]);
        if (hs > 0.05) {
            const target = Math.atan2(state.vel[0], state.vel[2]);
            state.yaw += wrapAngle(target - state.yaw) * (1 - Math.exp(-dt * FLIGHT.turnRate));
        }
        const leanTarget = ((FLIGHT.lean * Math.PI) / 180) * Math.min(1, hs / FLIGHT.speed);
        state.lean += (leanTarget - state.lean) * (1 - Math.exp(-dt * FLIGHT.leanRate));

        // yaw about world up, then lean about the model's own right axis (top towards +Z, its front)
        state.rotation = qMul(qAxis(0, 1, 0, state.yaw), qAxis(1, 0, 0, state.lean));
        qMat3(state.rotation, state.rotMat);
        return state;
    };

    // turn and lean the splat about `pivot` (its centre); its loaded pose is the starting point
    let entity = null;
    let base = null;
    let last = '';
    const applyToModel = (app, pivot) => {
        if (!entity) {
            entity = app.root.findComponents('gsplat')[0]?.entity ?? null;
            if (!entity) return;
            const p = entity.getLocalPosition();
            const q = entity.getLocalRotation();
            base = { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] };
        }
        const r = state.rotation;
        const key = r.map((v) => v.toFixed(5)).join();
        if (key === last) return;
        last = key;
        const q = qMul(r, base.q);
        const m = state.rotMat;
        const d = [base.p[0] - pivot[0], base.p[1] - pivot[1], base.p[2] - pivot[2]];
        entity.setLocalPosition(
            pivot[0] + m[0] * d[0] + m[3] * d[1] + m[6] * d[2],
            pivot[1] + m[1] * d[0] + m[4] * d[1] + m[7] * d[2],
            pivot[2] + m[2] * d[0] + m[5] * d[1] + m[8] * d[2]
        );
        entity.setLocalRotation(q[0], q[1], q[2], q[3]);
        // the viewer only redraws when its camera moves; the model moved, so ask for a frame
        app.renderNextFrame = true;
    };

    return { state, update, applyToModel };
};

// a small key guide, top left; it fades away once the user has started flying
const createHint = () => {
    const touchOnly = window.matchMedia?.('(hover: none)').matches;
    const el = document.createElement('div');
    el.className = 'flight-hint';
    el.innerHTML =
        '<b>W A S D</b> 移動　<b>Space</b> 上昇　<b>Shift</b> 下降　<b>' +
        (IS_MAC ? 'Ctrl / ' : '') +
        'W×2</b> 加速';
    const style = document.createElement('style');
    style.textContent = `
        .flight-hint {
            position: fixed; top: 16px; left: 16px; z-index: 2;
            padding: 6px 12px; border-radius: 999px;
            background: rgba(4, 10, 32, 0.55); color: rgba(255, 255, 255, 0.82);
            font: 12px/1.5 system-ui, -apple-system, "Hiragino Sans", sans-serif;
            letter-spacing: 0.02em; pointer-events: none;
            transition: opacity 1.2s ease;
        }
        .flight-hint b { color: #fff; font-weight: 600; }
        .flight-hint.is-hidden { opacity: 0; }
    `;
    if (!touchOnly) {
        document.head.appendChild(style);
        document.body.appendChild(el);
    }
    let timer = 0;
    return {
        dismissSoon() {
            clearTimeout(timer);
            timer = setTimeout(() => el.classList.add('is-hidden'), 5000);
        }
    };
};
