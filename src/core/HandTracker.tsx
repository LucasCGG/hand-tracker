import { useEffect, useRef, useState } from "react";

type Pt = [number, number];
type Box = { minX: number; maxX: number; minY: number; maxY: number };

export const HandTracker = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handCanvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  const smoothBoxRef = useRef<Box | null>(null);
  const cursorRef = useRef<Pt | null>(null);
  const confidenceRef = useRef(0);
  const prevGrayRef = useRef<Float32Array | null>(null);
  const lastHoverRef = useRef<Element | null>(null);

  const [rSlider, setRSlider] = useState(95);
  const [gSlider, setGSlider] = useState(40);
  const [bSlider, setBSlider] = useState(20);
  const [motionSlider, setMotionSlider] = useState(16);
  const [motionAmtSlider, setMotionAmtSlider] = useState(279);
  const [fingersSlider, setFingersSlider] = useState(2);

  const rRef = useRef(rSlider), gRef = useRef(gSlider), bRef = useRef(bSlider);
  const mRef = useRef(motionSlider), maRef = useRef(motionAmtSlider);
  const fingersRef = useRef(fingersSlider);

  const BOX_SMOOTH = 0.7;
  const CURSOR_SMOOTH = 0.8;
  const CONF_MAX = 15;
  const CONF_GAIN = 2;
  const CONF_DROP = 1;
  const CONF_SHOW = 3;
  const BG_BLEND = 0.9;

  const videoFromWebcam = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: 1280,
        height: 720,
        frameRate: { ideal: 60 },
      },
      audio: false,
    });
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
  };

  const erodeDilate = (src: Uint8Array, w: number, h: number): Uint8Array => {
    const tmp = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        tmp[i] = src[i] && src[i - 1] && src[i + 1] && src[i - w] && src[i + w] ? 1 : 0;
      }
    }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        out[i] = tmp[i] || tmp[i - 1] || tmp[i + 1] || tmp[i - w] || tmp[i + w] ? 1 : 0;
      }
    }
    return out;
  };

  const dilateErode = (src: Uint8Array, w: number, h: number): Uint8Array => {
    const tmp = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        tmp[i] = src[i] || src[i-1] || src[i+1] || src[i-w] || src[i+w] ? 1 : 0;
      }
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        out[i] = tmp[i] && tmp[i-1] && tmp[i+1] && tmp[i-w] && tmp[i+w] ? 1 : 0;
      }
    return out;
  };

  const blurGray = (src: Float32Array, w: number, h: number, r: number): Float32Array => {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const win = r * 2 + 1;

    for (let y = 0; y < h; y++) {
      let sum = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / win;
        const add = row + Math.min(w - 1, x + r + 1);
        const sub = row + Math.max(0, x - r);
        sum += src[add] - src[sub];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[x + w * Math.min(h - 1, Math.max(0, y))];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / win;
        const add = x + w * Math.min(h - 1, y + r + 1);
        const sub = x + w * Math.max(0, y - r);
        sum += tmp[add] - tmp[sub];
      }
    }
    return out;
  };


  const lerp = (a: number, b: number, t: number) => a * t + b * (1 - t);

  const draw = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true });
    if (!video || !canvas || !ctx || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(draw);
      return;
    }

    const w = canvas.width, h = canvas.height;
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
    const frame = ctx.getImageData(0, 0, w, h);
    const data = frame.data;

    if (!prevGrayRef.current || prevGrayRef.current.length !== w * h) {
      prevGrayRef.current = new Float32Array(w * h);
    }
    const prevGray = prevGrayRef.current;

    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = (data[i] + data[i + 1] + data[i + 2]) / 3;
    }

    const blurred = blurGray(gray, w, h, 2);

    const skinMask = new Uint8Array(w * h);
    const motionMask = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);

      const isSkin =
        r > rRef.current && g > gRef.current && b > bRef.current &&
        r > g && g >= b &&
        r - g > 15 && r - b > 25 &&
        mx - mn > 20 && r < 250;

      const bg = prevGray[p];
      const moved = Math.abs(blurred[p] - bg) > mRef.current;
      prevGray[p] = bg * BG_BLEND + blurred[p] * (1 - BG_BLEND);

      skinMask[p] = isSkin ? 1 : 0;
      motionMask[p] = (isSkin && moved) ? 1 : 0;
    }

    let cleanMask = erodeDilate(skinMask, w, h);
    cleanMask = erodeDilate(cleanMask, w, h);
    cleanMask = dilateErode(cleanMask, w, h);
    cleanMask = dilateErode(cleanMask, w, h);

    const visited = new Uint8Array(w * h);
    const blobs: (Box & { area: number })[] = [];
    for (let start = 0; start < cleanMask.length; start++) {
      if (cleanMask[start] === 0 || visited[start]) continue;
      const stack = [start];
      visited[start] = 1;
      let area = 0, minX = w, maxX = 0, minY = h, maxY = 0;
      while (stack.length) {
        const p = stack.pop()!;
        const x = p % w, y = (p / w) | 0;
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const neighbors = [
          x > 0 ? p - 1 : -1,
          x < w - 1 ? p + 1 : -1,
          y > 0 ? p - w : -1,
          y < h - 1 ? p + w : -1,
        ];
        for (const n of neighbors) {
          if (n >= 0 && cleanMask[n] === 1 && !visited[n]) {
            visited[n] = 1;
            stack.push(n);
          }
        }
      }
      if (area > 500) blobs.push({ area, minX, maxX, minY, maxY });
    }

    const scoreBlob = (b: Box & { area: number }) => {
      const boxW = b.maxX - b.minX + 1;
      const boxH = b.maxY - b.minY + 1;
      const solidity = b.area / (boxW * boxH);
      const aspect = boxH / boxW;
      return { ...b, solidity, aspect };
    };

    const motionInBox = (b: Box) => {
      let count = 0;
      for (let y = b.minY; y <= b.maxY; y++)
        for (let x = b.minX; x <= b.maxX; x++)
          if (motionMask[y * w + x]) count++;
      return count;
    };

    const looksLikeHand = (b: Box & { area: number }) => {
      const boxW = b.maxX - b.minX + 1;
      const boxH = b.maxY - b.minY + 1;
      const minRun = Math.max(3, Math.round(boxW * 0.02));
      const minGap = Math.max(6, Math.round(boxW * 0.04));
      const fingerZone = b.minY + Math.floor(boxH * 0.6);
      const tipRows = Math.max(6, Math.floor(boxH * 0.08));

      let maxFingers = 0, maxWidth = 0, tipSum = 0, tipN = 0;

      for (let y = b.minY; y <= b.maxY; y++) {
        let left = -1, right = -1;
        const runs: [number, number][] = [];
        let s = -1;
        for (let x = b.minX; x <= b.maxX + 1; x++) {
          const on = x <= b.maxX && cleanMask[y * w + x] === 1;
          if (on) { if (left === -1) left = x; right = x; }
          if (on && s === -1) s = x;
          else if (!on && s !== -1) { runs.push([s, x - 1]); s = -1; }
        }
        const rowW = left === -1 ? 0 : right - left + 1;
        if (rowW > maxWidth) maxWidth = rowW;
        if (y - b.minY < tipRows && rowW > 0) { tipSum += rowW; tipN++; }

        if (y <= fingerZone) {
          const kept: [number, number][] = [];
          for (const [rs, re] of runs) {
            if (re - rs + 1 < minRun) continue;
            if (kept.length && rs - kept[kept.length - 1][1] < minGap)
              kept[kept.length - 1][1] = re;
            else kept.push([rs, re]);
          }
          if (kept.length > maxFingers) maxFingers = kept.length;
        }
      }

      const openHand = maxFingers >= fingersRef.current;
      const tipWidth = tipN ? tipSum / tipN : maxWidth;
      const pointingFinger = maxWidth > 0 && tipWidth <= 0.45 * maxWidth;
      return openHand || pointingFinger;
    };

    const candidates = blobs
      .map(scoreBlob)
      .filter(b =>
        b.area > 3000 && b.solidity < 0.75 && b.aspect > 0.4 && b.aspect < 2.6 &&
        motionInBox(b) > maRef.current &&
        looksLikeHand(b));

    let hand: (typeof candidates)[0] | null = null;
    if (candidates.length) {
      const prevBox = smoothBoxRef.current;
      if (prevBox) {
        const pcx = (prevBox.minX + prevBox.maxX) / 2;
        const pcy = (prevBox.minY + prevBox.maxY) / 2;
        hand = candidates.reduce((a, b) => {
          const ac = Math.hypot((a.minX + a.maxX) / 2 - pcx, (a.minY + a.maxY) / 2 - pcy);
          const bc = Math.hypot((b.minX + b.maxX) / 2 - pcx, (b.minY + b.maxY) / 2 - pcy);
          return bc - b.area * 0.02 < ac - a.area * 0.02 ? b : a;
        });
      } else {
        hand = candidates.reduce((a, b) => {
          const aScore = a.area * (1 - a.solidity);
          const bScore = b.area * (1 - b.solidity);
          return bScore > aScore ? b : a;
        });
      }
    }

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const v = cleanMask[p] ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    ctx.putImageData(frame, 0, 0);

    let goodFrame = false;
    let tipX = -1, tipY = h;

    if (hand) {
      const hc = handCanvasRef.current;
      const hctx = hc?.getContext("2d");
      if (hc && hctx) {
        const bw = hand.maxX - hand.minX + 1;
        const bh = hand.maxY - hand.minY + 1;
        if (hc.width !== bw || hc.height !== bh) { hc.width = bw; hc.height = bh; }
        const handImg = hctx.createImageData(bw, bh);
        const hd = handImg.data;
        for (let y = 0; y < bh; y++) {
          for (let x = 0; x < bw; x++) {
            const srcIdx = (hand.minY + y) * w + (hand.minX + x);
            const dstIdx = (y * bw + x) * 4;
            const on = cleanMask[srcIdx] ? 255 : 0;
            hd[dstIdx] = on;
            hd[dstIdx + 1] = on;
            hd[dstIdx + 2] = on;
            hd[dstIdx + 3] = 255;
          }
        }
        hctx.putImageData(handImg, 0, 0);
      }

      let found = false;
      for (let y = hand.minY; y <= hand.maxY && !found; y++) {
        for (let x = hand.minX; x <= hand.maxX; x++) {
          if (cleanMask[y * w + x]) {
            tipX = x; tipY = y; found = true;
            break;
          }
        }
      }
      if (found) goodFrame = true;
    }

    if (goodFrame) {
      confidenceRef.current = Math.min(CONF_MAX, confidenceRef.current + CONF_GAIN);
    } else {
      confidenceRef.current = Math.max(0, confidenceRef.current - CONF_DROP);
    }

    const tracking = confidenceRef.current >= CONF_SHOW;

    if (goodFrame && hand) {
      const prevB = smoothBoxRef.current;
      const sb: Box = prevB
        ? {
            minX: lerp(prevB.minX, hand.minX, BOX_SMOOTH),
            maxX: lerp(prevB.maxX, hand.maxX, BOX_SMOOTH),
            minY: lerp(prevB.minY, hand.minY, BOX_SMOOTH),
            maxY: lerp(prevB.maxY, hand.maxY, BOX_SMOOTH),
          }
        : { minX: hand.minX, maxX: hand.maxX, minY: hand.minY, maxY: hand.maxY };
      smoothBoxRef.current = sb;

      const prevCur = cursorRef.current;
      const cursor: Pt = prevCur
        ? [lerp(prevCur[0], tipX, CURSOR_SMOOTH), lerp(prevCur[1], tipY, CURSOR_SMOOTH)]
        : [tipX, tipY];
      cursorRef.current = cursor;
    } else if (confidenceRef.current === 0) {
      smoothBoxRef.current = null;
      cursorRef.current = null;
    }

    if (tracking && cursorRef.current) {
      const rect = canvas.getBoundingClientRect();
      const pageX = rect.left + (cursorRef.current[0] / w) * rect.width;
      const pageY = rect.top + (cursorRef.current[1] / h) * rect.height;

      const el = document.elementFromPoint(pageX, pageY);
      if (el && el !== lastHoverRef.current) {
        lastHoverRef.current?.dispatchEvent(
          new MouseEvent("mouseout", { clientX: pageX, clientY: pageY, bubbles: true })
        );
        el.dispatchEvent(
          new MouseEvent("mouseover", { clientX: pageX, clientY: pageY, bubbles: true })
        );
        lastHoverRef.current = el;
      }
      el?.dispatchEvent(
        new MouseEvent("mousemove", { clientX: pageX, clientY: pageY, bubbles: true })
      );
    }

    if (tracking && smoothBoxRef.current && cursorRef.current) {
      const sb = smoothBoxRef.current;
      const cursor = cursorRef.current;

      ctx.lineWidth = 3;
      ctx.strokeStyle = "lime";
      ctx.strokeRect(sb.minX, sb.minY, sb.maxX - sb.minX, sb.maxY - sb.minY);

      ctx.fillStyle = "cyan";
      ctx.beginPath();
      ctx.arc(cursor[0], cursor[1], 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "black";
      ctx.lineWidth = 2;
      ctx.stroke();

      const nx = (cursor[0] / w).toFixed(2);
      const ny = (cursor[1] / h).toFixed(2);
      ctx.fillStyle = "lime";
      ctx.font = "24px sans-serif";
      ctx.fillText(`cursor: ${nx}, ${ny}`, 10, 30);
    }

    rafRef.current = requestAnimationFrame(draw);
  };

  useEffect(() => { rRef.current = rSlider; }, [rSlider]);
  useEffect(() => { gRef.current = gSlider; }, [gSlider]);
  useEffect(() => { bRef.current = bSlider; }, [bSlider]);
  useEffect(() => { mRef.current = motionSlider; }, [motionSlider]);
  useEffect(() => { maRef.current = motionAmtSlider; }, [motionAmtSlider]);
  useEffect(() => { fingersRef.current = fingersSlider; }, [fingersSlider]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) { canvas.width = 1280; canvas.height = 720; }
    videoFromWebcam();
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      const stream = videoRef.current?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <>
      <video ref={videoRef} autoPlay playsInline muted style={{ display: "none" }} />
      <canvas ref={canvasRef} />
      <canvas ref={handCanvasRef} style={{ border: "1px solid lime", marginLeft: 12 }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12, maxWidth: 400 }}>
        <label>R: {rSlider}
          <input type="range" min={0} max={255} value={rSlider}
            onChange={(e) => setRSlider(Number(e.target.value))} style={{ width: "100%" }} />
        </label>
        <label>G: {gSlider}
          <input type="range" min={0} max={255} value={gSlider}
            onChange={(e) => setGSlider(Number(e.target.value))} style={{ width: "100%" }} />
        </label>
        <label>B: {bSlider}
          <input type="range" min={0} max={255} value={bSlider}
            onChange={(e) => setBSlider(Number(e.target.value))} style={{ width: "100%" }} />
        </label>
        <label>Motion sensitivity (per-pixel): {motionSlider}
          <input type="range" min={0} max={60} value={motionSlider}
            onChange={(e) => setMotionSlider(Number(e.target.value))} style={{ width: "100%" }} />
        </label>
        <label>Motion amount (gate): {motionAmtSlider}
          <input type="range" min={0} max={2000} value={motionAmtSlider}
            onChange={(e) => setMotionAmtSlider(Number(e.target.value))} style={{ width: "100%" }} />
        </label>
        <label>Min fingers (hand vs face): {fingersSlider}
          <input type="range" min={1} max={5} value={fingersSlider}
            onChange={(e) => setFingersSlider(Number(e.target.value))} style={{ width: "100%" }} />
        </label>
      </div>
    </>
  );
};
