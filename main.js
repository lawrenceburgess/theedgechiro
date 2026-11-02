(() => {
  const FRAME_COUNT = 121;
  const DESKTOP_DIR = "frames/desktop";
  const MOBILE_DIR = "frames/mobile";
  const PIN_VH_MULTIPLIER = 4.5; // screen heights spent playing the 121 frames
  const REVEAL_VH_MULTIPLIER = 1.4; // extra screen heights spent shrinking to reveal the full wordmark
  const FRAME_PHASE_SHARE = PIN_VH_MULTIPLIER / (PIN_VH_MULTIPLIER + REVEAL_VH_MULTIPLIER);
  const REVEAL_SHRINK_TO = 0.7;
  const LOAD_CONCURRENCY = 6;

  // Copy fade windows as [fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd],
  // expressed as a fraction of the frame-playback phase (not the whole pin).
  const HERO_EXIT_END = 0.05;
  const LINE_WINDOWS = [
    [0.03, 0.10, 0.22, 0.30],
    [0.36, 0.44, 0.56, 0.64],
    [0.66, 0.74, 0.86, 0.94],
  ];

  const canvas = document.getElementById("spine-canvas");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("pin-stage");
  const pinSection = document.getElementById("pin-section");
  const progressBar = document.getElementById("scroll-progress");
  const loadingEl = document.getElementById("loading-indicator");
  const lines = Array.from(document.querySelectorAll(".copy .line"));
  const heroIntro = document.getElementById("hero-intro");
  const heroTitle = document.querySelector(".hero-title");
  const heroHint = document.getElementById("hero-hint");

  const orientationQuery = window.matchMedia("(orientation: portrait)");
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reducedMotion = reducedMotionQuery.matches;

  const seq = {
    dir: null,
    images: [],
    generation: 0,
    currentIndex: -1,
    loadedCount: 0,
  };

  let revealImage = null;

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

  // object-fit: cover math, with an extra `shrink` factor (<1) that pulls the
  // image in further than cover would, exposing more of its original width.
  function drawCoverShrink(img, shrink) {
    const cw = canvas.width, ch = canvas.height;
    const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight) * shrink;
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

  // Frame 121's wordmark is cropped on the mobile asset (it's a narrow
  // center strip of the source footage). Rather than mask/overlay it, the
  // reveal phase switches to the uncropped desktop frame and shrinks the
  // cover-fit scale below 1, which pulls the previously-cropped edges (and
  // the full wordmark) back into view.
  function loadRevealImage() {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => renderAtProgress(currentScrollProgress());
    img.src = frameSrc(DESKTOP_DIR, FRAME_COUNT - 1);
    revealImage = img;
  }

  function renderAtProgress(p) {
    if (p < FRAME_PHASE_SHARE) {
      const target = Math.round((p / FRAME_PHASE_SHARE) * (FRAME_COUNT - 1));
      const idx = nearestLoaded(target);
      if (idx === -1 || idx === seq.currentIndex) return;
      drawCoverShrink(seq.images[idx], 1);
      seq.currentIndex = idx;
    } else {
      const t = FRAME_PHASE_SHARE < 1 ? (p - FRAME_PHASE_SHARE) / (1 - FRAME_PHASE_SHARE) : 1;
      const shrink = 1 - (1 - REVEAL_SHRINK_TO) * Math.min(1, Math.max(0, t));
      const img = isReady(revealImage) ? revealImage : seq.images[nearestLoaded(FRAME_COUNT - 1)];
      if (!img) return;
      drawCoverShrink(img, shrink);
      seq.currentIndex = -2; // always redraw in the reveal phase; shrink changes continuously
    }
  }

  function triWindow(p, a, b, c, d) {
    if (p <= a || p >= d) return 0;
    if (p < b) return (p - a) / (b - a);
    if (p < c) return 1;
    return 1 - (p - c) / (d - c);
  }

  function updateCopy(p) {
    const heroOpacity = 1 - Math.min(1, p / (HERO_EXIT_END * FRAME_PHASE_SHARE));
    heroIntro.style.opacity = String(heroOpacity);

    lines.forEach((el, i) => {
      const [a, b, c, d] = LINE_WINDOWS[i].map((v) => v * FRAME_PHASE_SHARE);
      el.style.opacity = String(triWindow(p, a, b, c, d));
    });
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

  function playHeroEntrance() {
    if (reducedMotion) {
      gsap.set(heroTitle, { opacity: 1, scale: 1, filter: "blur(0px)" });
      gsap.set(heroHint, { opacity: 1, y: 0 });
      return;
    }
    gsap.set(heroTitle, { opacity: 0, scale: 4.5, filter: "blur(32px)" });
    gsap.set(heroHint, { opacity: 0, y: 12 });
    gsap.timeline({ delay: 0.15 })
      .to(heroTitle, { opacity: 1, scale: 1, filter: "blur(0px)", duration: 1.4, ease: "power4.out" })
      .to(heroHint, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, "-=0.35");
  }

  function initStaticFallback() {
    sizeCanvas();
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      sizeCanvas();
      drawCoverShrink(img, REVEAL_SHRINK_TO);
      loadingEl.remove();
    };
    img.src = frameSrc(DESKTOP_DIR, FRAME_COUNT - 1);
    heroIntro.style.opacity = "0";
    lines.forEach((l) => { l.style.opacity = "0"; });
  }

  function initAnimated() {
    sizeCanvas();
    loadSequence(pickDir());
    loadRevealImage();

    gsap.registerPlugin(ScrollTrigger);

    const lenis = new Lenis({ smoothWheel: true, duration: 1.1 });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);

    const totalVh = PIN_VH_MULTIPLIER + REVEAL_VH_MULTIPLIER;
    const st = ScrollTrigger.create({
      trigger: pinSection,
      start: "top top",
      end: () => `+=${window.innerHeight * totalVh}`,
      scrub: true,
      pin: true,
      anticipatePin: 1,
      invalidateOnRefresh: true,
      onUpdate: (self) => {
        progressBar.style.width = `${self.progress * 100}%`;
        renderAtProgress(self.progress);
        updateCopy(self.progress);
      },
      onRefresh: (self) => {
        scrollTriggerInstance = self;
      },
    });
    scrollTriggerInstance = st;

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

  playHeroEntrance();

  if (reducedMotion) {
    initStaticFallback();
  } else {
    initAnimated();
  }
})();
