(() => {
  const FRAME_COUNT = 177; // orbit+push-in -> crossfade -> vertebrae separation, extracted at 16fps
  const DESKTOP_DIR = "frames/drx9000/desktop";
  const PIN_VH_MULTIPLIER = 6; // screen heights spent scrubbing the sequence
  const LOAD_CONCURRENCY = 6;

  // Fade windows as [fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd], as a
  // fraction of this section's own scroll progress — matches the .copy .line
  // triangle-window pattern already used by the first hero in main.js.
  const HEADLINE_WINDOW = [0.0, 0.06, 0.22, 0.30];
  const SUBHEAD_WINDOW = [0.03, 0.10, 0.22, 0.30];

  const canvas = document.getElementById("drx-canvas");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("drx-stage");
  const pinSection = document.getElementById("drx-pin-section");
  const loadingEl = document.getElementById("drx-loading-indicator");
  const scrim = document.getElementById("drx-scrim");
  const lines = Array.from(document.querySelectorAll("#drx-copy .line"));

  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reducedMotion = reducedMotionQuery.matches;

  const seq = { images: new Array(FRAME_COUNT), loadedCount: 0, currentIndex: -1 };

  function frameSrc(i) {
    return `${DESKTOP_DIR}/frame_${String(i + 1).padStart(4, "0")}.webp`;
  }

  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(stage.clientWidth * dpr);
    const h = Math.round(stage.clientHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  // The source frames are landscape (16:9-ish). On a landscape stage,
  // cover-fit (filling both dimensions, cropping the overflow) looks right.
  // On a portrait/mobile stage, cover would crop almost the entire width
  // down to a tall, heavily-zoomed center sliver — most of the machine (and
  // most of the motion happening across the frame's width) would be cropped
  // out of view. So on a taller-than-wide stage, fit the whole frame width
  // in instead and letterbox top/bottom, over the stage's own dark
  // background, rather than crop it away.
  function drawCover(img) {
    const cw = canvas.width, ch = canvas.height;
    const portrait = ch > cw;
    const s = portrait
      ? Math.min(cw / img.naturalWidth, ch / img.naturalHeight)
      : Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    ctx.clearRect(0, 0, cw, ch);
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

  function triWindow(p, a, b, c, d) {
    if (p <= a || p >= d) return 0;
    if (p < b) return (p - a) / (b - a);
    if (p < c) return 1;
    return 1 - (p - c) / (d - c);
  }

  function renderAtProgress(p) {
    const target = Math.round(p * (FRAME_COUNT - 1));
    const idx = nearestLoaded(target);
    if (idx === -1 || idx === seq.currentIndex) return;
    drawCover(seq.images[idx]);
    seq.currentIndex = idx;
  }

  function updateCopy(p) {
    const [a, b, c, d] = HEADLINE_WINDOW;
    const [sa, sb, sc, sd] = SUBHEAD_WINDOW;
    const headlineOpacity = triWindow(p, a, b, c, d);
    if (lines[0]) lines[0].style.opacity = String(headlineOpacity);
    // Headline's window is the broadest of the three, so it doubles as the
    // scrim's envelope — the vignette comes and goes with the whole block.
    if (scrim) scrim.style.opacity = String(headlineOpacity);
    const subOpacity = triWindow(p, sa, sb, sc, sd);
    if (lines[1]) lines[1].style.opacity = String(subOpacity);
    // Button shares the subheading's fade window and only accepts clicks
    // once mostly faded in (see .drx-cta.ready in styles.css).
    if (lines[2]) {
      lines[2].style.opacity = String(subOpacity);
      lines[2].classList.toggle("ready", subOpacity > 0.6);
    }
  }

  function updateLoadingLabel() {
    if (seq.loadedCount >= FRAME_COUNT) {
      loadingEl.style.opacity = "0";
      setTimeout(() => loadingEl.remove(), 400);
      return;
    }
    loadingEl.textContent = `Loading ${seq.loadedCount}/${FRAME_COUNT}`;
  }

  function loadSequence() {
    let nextIndex = 0;
    const worker = () => {
      const i = nextIndex++;
      if (i >= FRAME_COUNT) return;
      const img = new Image();
      img.decoding = "async";
      const done = () => {
        seq.loadedCount++;
        updateLoadingLabel();
        renderAtProgress(currentScrollProgress());
        worker();
      };
      img.onload = done;
      img.onerror = done;
      img.src = frameSrc(i);
      seq.images[i] = img;
    };
    for (let w = 0; w < LOAD_CONCURRENCY; w++) worker();
    updateLoadingLabel();
  }

  let scrollTriggerInstance = null;
  function currentScrollProgress() {
    return scrollTriggerInstance ? scrollTriggerInstance.progress : 0;
  }

  function initStaticFallback() {
    sizeCanvas();
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { sizeCanvas(); drawCover(img); loadingEl.remove(); };
    img.onerror = () => loadingEl.remove();
    img.src = frameSrc(0);
    lines.forEach((l) => {
      l.style.opacity = "1";
      l.style.position = "static";
      l.classList.add("ready");
    });
    if (scrim) scrim.style.opacity = "1";
  }

  function initAnimated() {
    sizeCanvas();
    loadSequence();

    // GSAP/ScrollTrigger and the page's single Lenis instance (wired in
    // main.js, which calls ScrollTrigger.update() on every Lenis scroll
    // tick) are already running for the whole document by the time this
    // script executes — this section just adds its own pinned trigger to
    // that same global scroll loop, it doesn't need its own Lenis.
    gsap.registerPlugin(ScrollTrigger);

    const st = ScrollTrigger.create({
      trigger: pinSection,
      start: "top top",
      end: () => `+=${window.innerHeight * PIN_VH_MULTIPLIER}`,
      scrub: true,
      pin: true,
      anticipatePin: 1,
      invalidateOnRefresh: true,
      onUpdate: (self) => {
        renderAtProgress(self.progress);
        updateCopy(self.progress);
      },
      onRefresh: (self) => { scrollTriggerInstance = self; },
    });
    scrollTriggerInstance = st;

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
