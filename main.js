(() => {
  const FRAME_COUNT = 121;
  const DESKTOP_DIR = "frames/desktop";
  const MOBILE_DIR = "frames/mobile";
  const PIN_VH_MULTIPLIER = 4.5;
  const LOAD_CONCURRENCY = 6;

  // The baked-in wordmark isn't static in the mobile frames: the shot pulls
  // back through the final ~25 frames, so the text band drifts upward and
  // shrinks. These are measured (progress, top%, bottom%) checkpoints for
  // that band; updateWordmarkBand() interpolates between them every frame.
  const WORDMARK_KEYFRAMES = [
    [0.80, 0.80, 1.00],
    [0.855, 0.805, 0.90],
    [0.872, 0.785, 0.885],
    [0.940, 0.73, 0.82],
    [1.00, 0.635, 0.715],
  ];

  const canvas = document.getElementById("spine-canvas");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("pin-stage");
  const pinSection = document.getElementById("pin-section");
  const progressBar = document.getElementById("scroll-progress");
  const loadingEl = document.getElementById("loading-indicator");
  const lines = Array.from(document.querySelectorAll(".copy .line"));
  const wordmarkMask = document.getElementById("wordmark-mask");
  const mobileWordmark = document.getElementById("mobile-wordmark");

  const orientationQuery = window.matchMedia("(orientation: portrait)");
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  const seq = {
    dir: null,
    images: [],
    generation: 0,
    currentIndex: -1,
    loadedCount: 0,
  };

  function frameSrc(dir, i) {
    return `${dir}/frame_${String(i + 1).padStart(4, "0")}.webp`;
  }

  function pickDir() {
    return orientationQuery.matches ? MOBILE_DIR : DESKTOP_DIR;
  }

  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(stage.clientWidth * dpr);
    const h = Math.round(stage.clientHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  function drawCover(img) {
    const cw = canvas.width, ch = canvas.height;
    const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  function isReady(img) {
    return !!img && img.complete && img.naturalWidth > 0;
  }

  function nearestLoaded(idx) {
    if (isReady(seq.images[idx])) return idx;
    for (let d = 1; d < FRAME_COUNT; d++) {
      const back = idx - d, fwd = idx + d;
      if (back >= 0 && isReady(seq.images[back])) return back;
      if (fwd < FRAME_COUNT && isReady(seq.images[fwd])) return fwd;
    }
    return -1;
  }

  function renderAtProgress(p) {
    const target = Math.round(p * (FRAME_COUNT - 1));
    const idx = nearestLoaded(target);
    if (idx === -1 || idx === seq.currentIndex) return;
    drawCover(seq.images[idx]);
    seq.currentIndex = idx;
  }

  function updateLoadingLabel() {
    if (seq.loadedCount >= FRAME_COUNT) {
      loadingEl.style.opacity = "0";
      setTimeout(() => loadingEl.remove(), 400);
      return;
    }
    loadingEl.textContent = `Loading ${seq.loadedCount}/${FRAME_COUNT}`;
  }

  function loadSequence(dir) {
    const generation = ++seq.generation;
    seq.dir = dir;
    seq.images = new Array(FRAME_COUNT);
    seq.loadedCount = 0;
    seq.currentIndex = -1;

    const onFrameLoaded = () => {
      if (generation !== seq.generation) return;
      seq.loadedCount++;
      updateLoadingLabel();
      renderAtProgress(currentScrollProgress());
    };

    // Shared cursor: frame 0 loads first (so the hero paints immediately),
    // then N workers keep pulling the next index until all 121 are in.
    let nextIndex = 0;
    const worker = () => {
      if (generation !== seq.generation) return;
      const i = nextIndex++;
      if (i >= FRAME_COUNT) return;
      const img = new Image();
      img.decoding = "async";
      const done = () => { onFrameLoaded(); worker(); };
      img.onload = done;
      img.onerror = done;
      img.src = frameSrc(dir, i);
      seq.images[i] = img;
    };
    for (let w = 0; w < LOAD_CONCURRENCY; w++) worker();

    updateLoadingLabel();
  }

  function updateWordmarkBand(progress) {
    if (!orientationQuery.matches) return;
    const kf = WORDMARK_KEYFRAMES;
    let top, bottom;
    if (progress <= kf[0][0]) {
      [, top, bottom] = kf[0];
    } else if (progress >= kf[kf.length - 1][0]) {
      [, top, bottom] = kf[kf.length - 1];
    } else {
      let a = kf[0], b = kf[kf.length - 1];
      for (let i = 0; i < kf.length - 1; i++) {
        if (progress >= kf[i][0] && progress <= kf[i + 1][0]) { a = kf[i]; b = kf[i + 1]; break; }
      }
      const t = (progress - a[0]) / (b[0] - a[0]);
      top = a[1] + (b[1] - a[1]) * t;
      bottom = a[2] + (b[2] - a[2]) * t;
    }
    const topPct = `${(top * 100).toFixed(2)}%`;
    const heightPct = `${((bottom - top) * 100).toFixed(2)}%`;
    wordmarkMask.style.top = topPct;
    wordmarkMask.style.height = heightPct;
    mobileWordmark.style.top = topPct;
    mobileWordmark.style.height = heightPct;
  }

  let scrollTriggerInstance = null;
  function currentScrollProgress() {
    return scrollTriggerInstance ? scrollTriggerInstance.progress : 0;
  }

  function refreshOrientation() {
    const dir = pickDir();
    if (dir !== seq.dir) {
      loadSequence(dir);
    }
  }

  const reducedMotion = reducedMotionQuery.matches;

  function initStaticFallback() {
    sizeCanvas();
    const dir = pickDir();
    seq.dir = dir;
    seq.images = new Array(FRAME_COUNT);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      sizeCanvas();
      drawCover(img);
      loadingEl.remove();
    };
    img.src = frameSrc(dir, FRAME_COUNT - 1);
    seq.images[FRAME_COUNT - 1] = img;

    lines.forEach((l, i) => { l.style.opacity = i === lines.length - 1 ? "1" : "0"; });
    if (orientationQuery.matches) {
      wordmarkMask.style.opacity = "1";
      mobileWordmark.style.opacity = "1";
    }
  }

  function initAnimated() {
    sizeCanvas();
    loadSequence(pickDir());

    gsap.registerPlugin(ScrollTrigger);

    const lenis = new Lenis({ smoothWheel: true, duration: 1.1 });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: pinSection,
        start: "top top",
        end: () => `+=${window.innerHeight * PIN_VH_MULTIPLIER}`,
        scrub: true,
        pin: true,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          progressBar.style.width = `${self.progress * 100}%`;
          renderAtProgress(self.progress);
          updateWordmarkBand(self.progress);
        },
        onRefresh: (self) => {
          scrollTriggerInstance = self;
        },
      },
    });
    scrollTriggerInstance = tl.scrollTrigger;

    tl.to(lines[0], { opacity: 1, duration: 0.1 }, 0.04)
      .to(lines[0], { opacity: 0, duration: 0.08 }, 0.22)
      .to(lines[1], { opacity: 1, duration: 0.1 }, 0.38)
      .to(lines[1], { opacity: 0, duration: 0.08 }, 0.56)
      .to(lines[2], { opacity: 1, duration: 0.1 }, 0.64)
      .to(lines[2], { opacity: 0, duration: 0.08 }, 0.78)
      .to([wordmarkMask, mobileWordmark], { opacity: 1, duration: 0.12 }, 0.78)
      // No-op tween pinning the timeline's total duration to exactly 1, so
      // the position labels above (0.04 ... 0.9) line up 1:1 with scroll
      // progress instead of being rescaled against whatever the last label is.
      .to({}, { duration: 0.001 }, 1);

    orientationQuery.addEventListener("change", () => {
      refreshOrientation();
      requestAnimationFrame(() => {
        sizeCanvas();
        ScrollTrigger.refresh();
      });
    });

    let resizeRaf = null;
    window.addEventListener("resize", () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        sizeCanvas();
        renderAtProgress(currentScrollProgress());
        ScrollTrigger.refresh();
      });
    });
  }

  if (reducedMotion) {
    initStaticFallback();
  } else {
    initAnimated();
  }
})();
