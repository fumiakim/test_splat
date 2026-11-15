// space-fx.js — 宇宙背景の上に、モデルのまわりをゆっくり漂う光のパーティクルを重ねる。
//
// 仕組み
//  - ビューアのキャンバスは settings.json の background.color を [0,0,0,0] にして透過させ、
//    背景の青いグラデーション（index.html の CSS）が透けて見えるようにする。
//  - パーティクルは 3D 空間（モデルの中心まわり）に置き、ビューアのカメラ行列で投影するので、
//    視点を回すとモデルと一緒に動き、奥行き（視差）が出る。
//  - 描画は 2 枚の WebGL2 キャンバス:
//      back  … ビューアの後ろ（モデルより奥の粒。モデルに隠れる）
//      front … ビューアとUIの間（モデルより手前の粒。モデルの上に重なる）
//    モデル中心より手前か奥かで振り分け、境目はなめらかに重ね合わせる。
//  - 焦点（モデル中心の距離）から外れた粒ほど大きく柔らかいボケ玉になる（被写界深度風）。
//
// ?noparticles を URL に付けると無効になる。

const CONFIG = {
    // 数
    dust: 1900, // 細かい光の粒
    orbs: 220, // 少し大きめの光の玉
    stars: 1400, // 遠景の星
    // 見た目
    gain: 1.35, // 全体の明るさ
    cover: 0.6, // ボケ玉が背景を覆う割合（0 = 純粋な加算光、1 = 不透明な円）。上げるほど色が濃く見える
    aperture: 0.022, // ボケの強さ（大きいほど手前/奥の粒が大きくボケる）
    maxSizeRatio: 0.2, // ボケ玉の最大直径（画面の高さに対する比）
    frontMaxSizeRatio: 0.12, // モデルより手前のボケ玉の最大直径
    frontBokeh: 0.35, // モデルより手前のボケ玉の明るさ（小さいほどモデルが見やすい）
    // 動き
    timeScale: 1.0, // 全体の速さ
    swirl: 0.03, // モデルのまわりを回る速さ（rad/秒・内側ほど速い）
    // 配置（モデルの包み込む球の半径 = 1 とした単位）
    innerRadius: 0.8,
    outerRadius: 3.6,
    clearance: 1.25, // モデルのまわりで粒を出さない範囲（境界箱に対する倍率）
    starRadius: [22, 55],
    // モデルの境界が取れなかったときの代わり（カメラ距離に対する比）
    fallbackRadiusRatio: 0.6,
    maxDpr: 2
};

// sRGB の色と出現の重み。添付画像のような金〜橙を主体に、少しだけ淡い青。
const PALETTE = [
    { c: [1.0, 0.7, 0.28], w: 0.38 }, // gold
    { c: [1.0, 0.5, 0.14], w: 0.26 }, // amber
    { c: [1.0, 0.32, 0.08], w: 0.12 }, // orange-red
    { c: [1.0, 0.86, 0.58], w: 0.16 }, // warm white
    { c: [0.5, 0.76, 0.95], w: 0.08 } // pale blue
];
const STAR_PALETTE = [
    { c: [0.78, 0.86, 1.0], w: 0.62 },
    { c: [1.0, 0.95, 0.85], w: 0.2 },
    { c: [1.0, 0.75, 0.45], w: 0.18 }
];

// ---------------------------------------------------------------------------------------------
// particles

const mulberry32 = (seed) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const mix = (a, b, t) => a + (b - a) * t;

// per instance: pos(3) motion(4) phase(4) look(4) params(4) = 19 floats
const STRIDE = 19;

const buildParticles = () => {
    const rnd = mulberry32(20261115);
    const pick = (palette) => {
        let r = rnd();
        for (const p of palette) {
            if ((r -= p.w) <= 0) return p.c;
        }
        return palette[0].c;
    };
    const dir = () => {
        const z = rnd() * 2 - 1;
        const a = rnd() * Math.PI * 2;
        const s = Math.sqrt(1 - z * z);
        return [s * Math.cos(a), z, s * Math.sin(a)];
    };
    const TAU = Math.PI * 2;
    const total = CONFIG.dust + CONFIG.orbs + CONFIG.stars;
    const data = new Float32Array(total * STRIDE);
    let o = 0;

    const push = (pos, amp, freq, color, intensity, size, kind, twinkle, swirl) => {
        const jitter = 0.94 + rnd() * 0.12;
        data.set(
            [
                ...pos,
                amp,
                freq * mix(0.7, 1.3, rnd()),
                freq * mix(0.7, 1.3, rnd()),
                freq * mix(0.7, 1.3, rnd()),
                rnd() * TAU,
                rnd() * TAU,
                rnd() * TAU,
                rnd() * TAU,
                Math.min(1, color[0] * jitter),
                Math.min(1, color[1] * jitter),
                Math.min(1, color[2] * jitter),
                intensity,
                size,
                kind,
                twinkle,
                swirl
            ],
            o
        );
        o += STRIDE;
    };

    // swirl speed falls off with distance, like a slow orbit
    const swirlAt = (r) => (CONFIG.swirl * mix(0.8, 1.2, rnd())) / (0.5 + r * 0.5);

    for (let i = 0; i < CONFIG.dust; i++) {
        const r = mix(CONFIG.innerRadius, CONFIG.outerRadius, Math.pow(rnd(), 1.25));
        const d = dir();
        const pos = d.map((v) => v * r);
        push(
            pos,
            mix(0.02, 0.08, rnd()),
            TAU * mix(0.012, 0.05, rnd()),
            pick(PALETTE),
            mix(0.35, 1.35, Math.pow(rnd(), 1.8)),
            mix(0.0022, 0.0065, Math.pow(rnd(), 2)),
            0,
            mix(0.5, 2.6, rnd()),
            swirlAt(r)
        );
    }
    for (let i = 0; i < CONFIG.orbs; i++) {
        const r = mix(CONFIG.innerRadius, CONFIG.outerRadius * 0.9, Math.pow(rnd(), 1.1));
        const d = dir();
        const pos = d.map((v) => v * r);
        const blue = rnd() < 0.07;
        push(
            pos,
            mix(0.03, 0.1, rnd()),
            TAU * mix(0.01, 0.035, rnd()),
            blue ? [0.5, 0.78, 0.92] : pick(PALETTE.slice(0, 4)),
            mix(0.7, 1.5, rnd()),
            mix(0.009, 0.024, Math.pow(rnd(), 1.5)),
            0,
            mix(0.3, 1.2, rnd()),
            swirlAt(r)
        );
    }
    for (let i = 0; i < CONFIG.stars; i++) {
        const r = mix(CONFIG.starRadius[0], CONFIG.starRadius[1], rnd());
        const d = dir();
        push(
            d.map((v) => v * r),
            0,
            0,
            pick(STAR_PALETTE),
            mix(0.12, 0.75, Math.pow(rnd(), 2.2)),
            mix(0.55, 1.5, Math.pow(rnd(), 2)), // css px
            1,
            mix(0.4, 2.0, rnd()),
            0
        );
    }
    return { data, count: total };
};

// ---------------------------------------------------------------------------------------------
// shaders

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aPos;
layout(location = 2) in vec4 aMotion;  // amp, freq xyz
layout(location = 3) in vec4 aPhase;   // phase xyz, twinkle phase
layout(location = 4) in vec4 aLook;    // rgb, intensity
layout(location = 5) in vec4 aParams;  // size, kind, twinkle speed, swirl speed

uniform mat4 uView;
uniform vec2 uProj;        // projection scale x, y
uniform vec3 uCenter;
uniform float uScale;      // model bounding radius (world)
uniform vec3 uHalfExt;     // model clearance half extents (world)
uniform float uTime;
uniform vec2 uViewport;    // device px
uniform float uDpr;
uniform float uFocus;      // view depth of the model centre
uniform float uBand;       // front/back blend band (world)
uniform float uAperture;
uniform float uMaxSize;    // device px
uniform float uLayer;      // 0 back, 1 front
uniform float uGain;
uniform float uFrontBokeh;
uniform float uCover;

out vec2 vUv;
out vec3 vColor;
out float vAlpha;
out float vBlur;
out float vEdge;
out float vCover;

void main() {
    vUv = aCorner;
    vColor = aLook.rgb;
    vAlpha = 0.0;
    vBlur = 0.0;
    vEdge = 0.1;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

    // slow swirl around the vertical axis, then a gentle wander
    float ang = uTime * aParams.w;
    float c = cos(ang), s = sin(ang);
    vec3 p = aPos;
    p.xz = vec2(c * p.x - s * p.z, s * p.x + c * p.z);
    p += aMotion.x * sin(uTime * aMotion.yzw + aPhase.xyz);

    vec3 world = uCenter + p * uScale;
    vec4 v = uView * vec4(world, 1.0);
    float depth = -v.z;
    if (depth < 0.02) return;

    float tw = 0.5 + 0.5 * sin(uTime * aParams.z + aPhase.w);
    float intensity = aLook.a * uGain;
    float sizePx;
    float blur = 0.0;
    float pxPerUnit = uProj.y * 0.5 * uViewport.y / depth;

    if (aParams.y < 0.5) {
        // field particle with depth-of-field
        float sharp = max(aParams.x * uScale * pxPerUnit, 1.1 * uDpr);
        float coc = uAperture * uViewport.y * abs(depth - uFocus) / depth;
        float D = sqrt(sharp * sharp + coc * coc);
        blur = smoothstep(0.0, 1.0, (coc - sharp) / max(5.0 * uDpr, 2.0 * sharp));
        sizePx = mix(sharp * 4.0, D * 1.1, blur);
        float spread = clamp(2.5 * sharp / D, 0.0, 1.0);
        intensity *= mix(1.0, 0.28 + 0.6 * spread, blur);
        intensity *= mix(mix(0.3, 1.0, tw), mix(0.8, 1.0, tw), blur);

        // keep clear of the model itself
        vec3 q = (world - uCenter) / uHalfExt;
        intensity *= smoothstep(1.0, 1.6, length(q));

        // very close or very large: fade away instead of filling the screen
        intensity *= smoothstep(0.12 * uScale, 0.45 * uScale, depth);
        intensity *= 1.0 - smoothstep(uMaxSize * 0.55, uMaxSize, sizePx);
        sizePx = min(sizePx, uMaxSize);
        vBlur = blur;
        // some discs crisp-edged, most soft, as with a real lens
        vEdge = clamp(max(2.5 / sizePx, mix(0.08, 0.45, fract(aPhase.w * 7.13))), 0.04, 0.6);
    } else {
        // distant star: fixed pixel size
        sizePx = aParams.x * uDpr * 4.0;
        intensity *= mix(0.35, 1.0, tw);
    }

    // in front of the model centre goes on the front layer, behind on the back layer
    float wFront = smoothstep(uFocus + uBand, uFocus - uBand, depth);
    intensity *= uLayer > 0.5 ? wFront : 1.0 - wFront;
    // soft discs in front of the model are kept faint so they do not veil it
    if (uLayer > 0.5) intensity *= mix(1.0, uFrontBokeh, blur);
    if (intensity < 0.003) return;

    vAlpha = intensity;
    vCover = uCover * blur;
    vec2 ndc = vec2(uProj.x * v.x, uProj.y * v.y) / depth;
    gl_Position = vec4(ndc + aCorner * sizePx / uViewport, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vColor;
in float vAlpha;
in float vBlur;
in float vEdge;
in float vCover;
out vec4 outColor;

void main() {
    float d = length(vUv);
    if (d > 1.0) discard;
    // in focus: bright core with a soft halo (the quad is 4x the core)
    float sharp = exp(-d * d * 36.0) + 0.32 * exp(-d * d * 7.0);
    // out of focus: a flat disc, slightly brighter at the rim, like a lens bokeh
    float disc = 1.0 - smoothstep(1.0 - vEdge, 1.0, d);
    float bokeh = disc * (0.78 + 0.3 * smoothstep(0.5, 0.96, d));
    float shape = mix(sharp, bokeh, vBlur);
    vec3 col = mix(vColor, vec3(1.0), exp(-d * d * 110.0) * 0.65 * (1.0 - vBlur));
    float a = clamp(shape * vAlpha, 0.0, 1.0);
    // premultiplied: light is added, and an out-of-focus disc also covers a little of what is
    // behind it, so a warm disc reads as warm over the blue instead of turning grey
    outColor = vec4(col * a, a * vCover);
}`;

// ---------------------------------------------------------------------------------------------
// one WebGL2 canvas

class Layer {
    constructor(canvas, layerIndex, particles) {
        this.canvas = canvas;
        this.layerIndex = layerIndex;
        const gl = canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: true,
            antialias: false,
            depth: false,
            stencil: false,
            powerPreference: 'high-performance'
        });
        if (!gl) throw new Error('WebGL2 is not available');
        this.gl = gl;

        const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
            return sh;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        this.prog = prog;
        this.u = {};
        for (const name of [
            'uView', 'uProj', 'uCenter', 'uScale', 'uHalfExt', 'uTime', 'uViewport', 'uDpr',
            'uFocus', 'uBand', 'uAperture', 'uMaxSize', 'uLayer', 'uGain', 'uFrontBokeh', 'uCover'
        ]) {
            this.u[name] = gl.getUniformLocation(prog, name);
        }

        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        const quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        const inst = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, inst);
        gl.bufferData(gl.ARRAY_BUFFER, particles.data, gl.STATIC_DRAW);
        const sizes = [3, 4, 4, 4, 4];
        let offset = 0;
        sizes.forEach((n, i) => {
            gl.enableVertexAttribArray(i + 1);
            gl.vertexAttribPointer(i + 1, n, gl.FLOAT, false, STRIDE * 4, offset * 4);
            gl.vertexAttribDivisor(i + 1, 1);
            offset += n;
        });
        gl.bindVertexArray(null);
        this.count = particles.count;

        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE); // additive light
        gl.clearColor(0, 0, 0, 0);
    }

    resize(dpr) {
        const { canvas } = this;
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        return [w, h];
    }

    draw(frame) {
        const { gl, u } = this;
        const [w, h] = this.resize(frame.dpr);
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (frame.hidden) return;
        gl.useProgram(this.prog);
        gl.uniformMatrix4fv(u.uView, false, frame.view);
        gl.uniform2f(u.uProj, frame.projX(w, h), frame.projY(w, h));
        gl.uniform3fv(u.uCenter, frame.center);
        gl.uniform1f(u.uScale, frame.radius);
        gl.uniform3fv(u.uHalfExt, frame.halfExt);
        gl.uniform1f(u.uTime, frame.time);
        gl.uniform2f(u.uViewport, w, h);
        gl.uniform1f(u.uDpr, frame.dpr);
        gl.uniform1f(u.uFocus, frame.focus);
        gl.uniform1f(u.uBand, frame.band);
        gl.uniform1f(u.uAperture, CONFIG.aperture);
        gl.uniform1f(u.uMaxSize, (this.layerIndex ? CONFIG.frontMaxSizeRatio : CONFIG.maxSizeRatio) * h);
        gl.uniform1f(u.uFrontBokeh, CONFIG.frontBokeh);
        gl.uniform1f(u.uCover, CONFIG.cover);
        gl.uniform1f(u.uLayer, this.layerIndex);
        gl.uniform1f(u.uGain, CONFIG.gain * frame.fade);
        gl.bindVertexArray(this.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
        gl.bindVertexArray(null);
    }
}

// ---------------------------------------------------------------------------------------------
// camera helpers (column-major 4x4, like PlayCanvas)

const invert = (m, out) => {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return false;
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return true;
};

// camera world matrix looking from `pos` at `target`, y up
const lookAt = (pos, target) => {
    let zx = pos[0] - target[0];
    let zy = pos[1] - target[1];
    let zz = pos[2] - target[2];
    let l = Math.hypot(zx, zy, zz) || 1;
    zx /= l; zy /= l; zz /= l;
    let xx = zz;
    let xy = 0;
    let xz = -zx;
    l = Math.hypot(xx, xy, xz) || 1;
    xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    return [xx, xy, xz, 0, yx, yy, yz, 0, zx, zy, zz, 0, pos[0], pos[1], pos[2], 1];
};

// world-space bounds of the splat, from the engine's own aabb
const readBounds = (app) => {
    const gs = app.root?.findComponents?.('gsplat')?.[0];
    const aabb = gs?.customAabb;
    if (!aabb) return null;
    const m = gs.entity.getWorldTransform().data;
    const c = aabb.center;
    const e = aabb.halfExtents;
    const center = [0, 1, 2].map((i) => m[i] * c.x + m[4 + i] * c.y + m[8 + i] * c.z + m[12 + i]);
    const halfExt = [0, 1, 2].map(
        (i) => Math.abs(m[i]) * e.x + Math.abs(m[4 + i]) * e.y + Math.abs(m[8 + i]) * e.z
    );
    if (!halfExt.every((v) => v > 1e-4 && Number.isFinite(v))) return null;
    return { center, halfExt };
};

// ---------------------------------------------------------------------------------------------

const start = async () => {
    const params = new URL(location.href).searchParams;
    if (params.has('noparticles')) return;

    const settings = await Promise.resolve(window.sse?.settings).catch(() => null);
    const initial = settings?.cameras?.[0]?.initial ?? {};
    const camPos = initial.position ?? [0, 0, 4];
    const camTarget = initial.target ?? [0, 0, 0];
    const camFov = initial.fov ?? 75;
    const camDist = Math.hypot(camPos[0] - camTarget[0], camPos[1] - camTarget[1], camPos[2] - camTarget[2]) || 3;

    const style = document.createElement('style');
    style.textContent = `
        .space-fx { pointer-events: none; }
        .space-fx-back { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 0; }
    `;
    document.head.appendChild(style);

    const backCanvas = document.createElement('canvas');
    backCanvas.className = 'space-fx space-fx-back';
    document.body.prepend(backCanvas);
    const frontCanvas = document.createElement('canvas');
    frontCanvas.className = 'space-fx space-fx-front';

    const particles = buildParticles();
    let back;
    let front = null;
    try {
        back = new Layer(backCanvas, 0, particles);
    } catch (err) {
        console.warn('space-fx disabled:', err);
        backCanvas.remove();
        return;
    }

    // the front layer sits right above the viewer's canvas and below its ui
    const attachFront = () => {
        if (front) return true;
        const viewerCanvas = document.querySelector('.sse-viewer > canvas');
        if (!viewerCanvas) return false;
        viewerCanvas.after(frontCanvas);
        try {
            front = new Layer(frontCanvas, 1, particles);
        } catch (err) {
            console.warn('space-fx front layer disabled:', err);
            frontCanvas.remove();
            front = false;
        }
        return true;
    };

    // bounds: start from the settings' camera target, ease onto the real splat bounds once known
    const fallbackR = camDist * CONFIG.fallbackRadiusRatio;
    const fallbackE = fallbackR / Math.sqrt(3);
    const bounds = { center: [...camTarget], halfExt: [fallbackE, fallbackE, fallbackE] };
    let targetBounds = null;

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const view = new Float32Array(16);
    const camWorld = new Float32Array(lookAt(camPos, camTarget));
    let proj = null; // [P0, P5] from the engine camera
    let horizontalFov = true;
    let fov = camFov;

    const frame = {
        view,
        center: new Float32Array(3),
        halfExt: new Float32Array(3),
        radius: 1,
        focus: camDist,
        band: 0.2,
        time: 0,
        dpr: 1,
        fade: 0,
        hidden: false,
        projX: (w, h) => {
            if (proj) return proj[0];
            const t = 1 / Math.tan((fov * Math.PI) / 360);
            return horizontalFov ? t : t / (w / h);
        },
        projY: (w, h) => {
            if (proj) return proj[1];
            const t = 1 / Math.tan((fov * Math.PI) / 360);
            return horizontalFov ? t * (w / h) : t;
        }
    };

    let app = null;
    let cameraComponent = null;
    let rafId = 0;
    let lastNow = performance.now();
    const startNow = lastNow;

    const render = () => {
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastNow) / 1000);
        lastNow = now;
        frame.time = ((now - startNow) / 1000) * CONFIG.timeScale * (reducedMotion ? 0.3 : 1);
        frame.fade = Math.min(1, (now - startNow) / 2500);
        frame.dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr);

        if (front === null) attachFront();

        // camera
        if (cameraComponent?.entity) {
            const p = cameraComponent.projectionMatrix?.data;
            proj = p ? [p[0], p[5]] : null;
            if (!proj) {
                fov = cameraComponent.fov;
                horizontalFov = cameraComponent.horizontalFov;
            }
            camWorld.set(cameraComponent.entity.getWorldTransform().data);
            frame.hidden = !!app.xr?.active;
        } else {
            horizontalFov = window.innerWidth > window.innerHeight;
        }
        invert(camWorld, view);

        // bounds
        if (app && !targetBounds) targetBounds = readBounds(app);
        if (targetBounds) {
            const k = 1 - Math.exp(-dt * 2.5);
            for (let i = 0; i < 3; i++) {
                bounds.center[i] += (targetBounds.center[i] - bounds.center[i]) * k;
                bounds.halfExt[i] += (targetBounds.halfExt[i] - bounds.halfExt[i]) * k;
            }
        }
        frame.center.set(bounds.center);
        const longest = Math.max(...bounds.halfExt);
        for (let i = 0; i < 3; i++) {
            frame.halfExt[i] = Math.max(bounds.halfExt[i], longest * 0.6) * CONFIG.clearance;
        }
        frame.radius = Math.hypot(...bounds.halfExt);
        frame.band = Math.max(0.05, Math.min(...bounds.halfExt) * 0.5);
        const [cx, cy, cz] = bounds.center;
        frame.focus = Math.max(0.05, -(view[2] * cx + view[6] * cy + view[10] * cz + view[14]));

        back.draw(frame);
        if (front) front.draw(frame);
    };

    // until the viewer exposes its app, draw on our own clock; afterwards draw in the app's frame
    // so the particles follow the camera without a frame of lag
    const loop = () => {
        const exposed = window.app;
        if (exposed?.on && exposed.root) {
            app = exposed;
            cameraComponent = app.root.findComponents('camera')[0] ?? null;
            app.on('framerender', render);
            render();
            return;
        }
        render();
        rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
};

start().catch((err) => console.warn('space-fx failed:', err));
