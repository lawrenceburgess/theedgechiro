(() => {
  const FRAME_COUNT = 121;
  const DESKTOP_DIR = "frames/desktop";
  const MOBILE_DIR = "frames/mobile";
  const PIN_VH_MULTIPLIER = 4.5; // screen heights spent playing the 121 frames
  const REVEAL_VH_MULTIPLIER = 1.4; // extra screen heights spent shrinking to reveal the full wordmark
  const NAVBAR_VH_MULTIPLIER = 1.3; // extra screen heights spent flying "THE EDGE" into the navbar
  const TOTAL_VH = PIN_VH_MULTIPLIER + REVEAL_VH_MULTIPLIER + NAVBAR_VH_MULTIPLIER;
  const FRAME_PHASE_SHARE = PIN_VH_MULTIPLIER / TOTAL_VH;
  const REVEAL_PHASE_END = (PIN_VH_MULTIPLIER + REVEAL_VH_MULTIPLIER) / TOTAL_VH;
  const REVEAL_SHRINK_TO = 0.85;
  const LOAD_CONCURRENCY = 6;

  const BG_DEEP = [14, 22, 36]; // dark muted blue revealed as the black curtain slides up

  // Pixel bounds of "THE EDGE" within frame_0121 desktop (2560x1440),
  // measured directly off the baked wordmark — see the crop verification
  // done while building this feature. DOCK_CROP_W is its on-screen width
  // once docked in the navbar; height follows the crop's own aspect ratio.
  const EDGE_CROP_RECT = { x: 890, y: 985, w: 325, h: 63 };
  const DOCK_CROP_W = 108;
  const DOCK_CROP_H = DOCK_CROP_W * (EDGE_CROP_RECT.h / EDGE_CROP_RECT.w);

  // Pixel bounds of the whole logo (spine + full wordmark) in the same
  // frame, similarly measured. Used so the whole thing can fly as one
  // rigid piece (sharing EDGE_CROP_RECT's scale reference "k" below) while
  // "THE EDGE" survives on top of it and everything else fades.
  const FULL_LOGO_RECT = { x: 885, y: 385, w: 795, h: 665 };

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

  const siteNav = document.getElementById("site-nav");
  const navCurtain = document.getElementById("nav-curtain");
  const edgeCrop = document.getElementById("edge-crop");
  const edgeCropImg = edgeCrop.querySelector("img");
  const fullLogoCrop = document.getElementById("full-logo-crop");
  const fullLogoCropImg = fullLogoCrop.querySelector("img");
  const navActions = document.getElementById("nav-actions");
  const menuToggle = document.getElementById("menu-toggle");
  const navMenu = document.getElementById("nav-menu");

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
  // The canvas is left transparent outside the drawn image (not filled
  // black) so that .pin-stage's own background shows through — identical to
  // black during the frame/reveal phases, but seamless once that background
  // turns blue and the canvas itself starts shrinking via CSS transform in
  // the navbar phase (an opaque fill would otherwise show up as a hard
  // rectangle edge shrinking along with it).
  function drawCoverShrink(img, shrink) {
    const cw = canvas.width, ch = canvas.height;
    const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight) * shrink;
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
      const span = REVEAL_PHASE_END - FRAME_PHASE_SHARE;
      const t = span > 0 ? (p - FRAME_PHASE_SHARE) / span : 1;
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

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (n) => Math.max(0, Math.min(1, n));

  // Both crops share this scale reference "k" (calibrated off the small
  // navbar-docked size of EDGE_CROP_RECT), so a given on-screen width for
  // either crop corresponds to the SAME underlying zoom level on the shared
  // source image — which is what lets them move as one rigid piece using
  // consistent math, even though they crop different regions.
  const CROP_K = DOCK_CROP_W / EDGE_CROP_RECT.w;

  // One-time layout: size each crop box, and scale/offset the full-frame
  // img inside it so its rect lines up exactly with the box. From here on,
  // only `transform` on the crop element itself changes — scaling this base
  // layout up/down as a unit, exactly like a sprite crop.
  function setupCrop(el, img, rect) {
    el.style.width = `${rect.w * CROP_K}px`;
    el.style.height = `${rect.h * CROP_K}px`;
    img.style.width = `${2560 * CROP_K}px`;
    img.style.height = `${1440 * CROP_K}px`;
    img.style.left = `${-rect.x * CROP_K}px`;
    img.style.top = `${-rect.y * CROP_K}px`;
  }

  function setupCrops() {
    setupCrop(edgeCrop, edgeCropImg, EDGE_CROP_RECT);
    setupCrop(fullLogoCrop, fullLogoCropImg, FULL_LOGO_RECT);
  }

  // Where `rect` lands on screen if the full frame were drawn with
  // drawCoverShrink(img, shrink) right now — i.e. exactly how the canvas
  // itself is rendering that region. Used to keep a crop perfectly aligned
  // with the canvas during the reveal phase, and as the fly animation's
  // continuity anchor once the canvas hands off to the crops.
  function cropRectForShrink(rect, shrink) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.width, ch = canvas.height;
    const s = Math.max(cw / 2560, ch / 1440) * shrink;
    const sCss = s / dpr;
    const ox = (cw - 2560 * s) / 2 / dpr;
    const oy = (ch - 1440 * s) / 2 / dpr;
    return {
      x: ox + rect.x * sCss,
      y: oy + rect.y * sCss,
      w: rect.w * sCss,
    };
  }

  function shrinkForProgress(p) {
    const span = REVEAL_PHASE_END - FRAME_PHASE_SHARE;
    const t = span > 0 ? (p - FRAME_PHASE_SHARE) / span : 1;
    return 1 - (1 - REVEAL_SHRINK_TO) * clamp01(t);
  }

  // The fly transform for a crop at a given navbar-phase progress: starts
  // (navT=0) exactly matching how the canvas rendered `rect` at the reveal
  // phase's final shrink, and ends (navT=1) fully docked (identity
  // transform, since each crop's own base layout already *is* its docked
  // appearance).
  function flyTransform(rect, navT, dockLeft, dockTop) {
    const boundary = cropRectForShrink(rect, REVEAL_SHRINK_TO);
    const scaleFrom = boundary.w / (rect.w * CROP_K);
    const txFrom = boundary.x - dockLeft;
    const tyFrom = boundary.y - dockTop;
    return {
      scale: lerp(scaleFrom, 1, navT),
      tx: lerp(txFrom, 0, navT),
      ty: lerp(tyFrom, 0, navT),
    };
  }

  function dockAnchor(el) {
    return {
      left: parseFloat(getComputedStyle(el).left) || 24,
      top: parseFloat(getComputedStyle(el).top) || 25,
    };
  }

  function updateEdgeCrop(p) {
    if (p < FRAME_PHASE_SHARE) {
      edgeCrop.style.opacity = "0";
      return;
    }
    edgeCrop.style.opacity = "1";
    const { left: dockLeft, top: dockTop } = dockAnchor(edgeCrop);

    let tx, ty, S;
    if (p <= REVEAL_PHASE_END) {
      const rect = cropRectForShrink(EDGE_CROP_RECT, shrinkForProgress(p));
      S = rect.w / DOCK_CROP_W;
      tx = rect.x - dockLeft;
      ty = rect.y - dockTop;
    } else {
      const span = 1 - REVEAL_PHASE_END;
      const navT = span > 0 ? clamp01((p - REVEAL_PHASE_END) / span) : 1;
      ({ scale: S, tx, ty } = flyTransform(EDGE_CROP_RECT, navT, dockLeft, dockTop));
    }
    edgeCrop.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${S.toFixed(4)})`;
  }

  // Once the reveal phase ends, the canvas hands off entirely to
  // .full-logo-crop — a tight crop of the whole logo (spine + full
  // wordmark) that flies toward the navbar using the exact same transform
  // math as .edge-crop (see flyTransform), so the whole thing moves as one
  // rigid piece instead of "THE EDGE" flying away from a logo left behind.
  // A black curtain, initially covering the whole stage, slides its bottom
  // edge up to the navbar's height, revealing the deep blue stage
  // background as it recedes. full-logo-crop is masked to that exact same
  // edge (with a soft feather right at the line) so spine + "CHIROPRACTIC"
  // dissolve exactly where the wipe is and never show up sitting on the
  // revealed blue — while edge-crop, unmasked, rides along on top and
  // survives the whole trip.
  const MASK_FEATHER_PX = 110;
  function updateFullLogoCrop(p, navT, inNavbarPhase, curtainHeightPx) {
    canvas.style.opacity = inNavbarPhase ? "0" : "1";
    if (!inNavbarPhase) {
      fullLogoCrop.style.opacity = "0";
      return;
    }
    fullLogoCrop.style.opacity = "1";

    const { left: dockLeft, top: dockTop } = dockAnchor(fullLogoCrop);
    const { scale, tx, ty } = flyTransform(FULL_LOGO_RECT, navT, dockLeft, dockTop);
    fullLogoCrop.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;

    // mask-image is positioned in the crop's own local (pre-transform)
    // space, so the wipe line's local Y has to be solved backwards from
    // where we want it to land on screen (curtainHeightPx) given the
    // transform just applied above.
    const localEdge = (curtainHeightPx - ty) / scale;
    const localFeather = MASK_FEATHER_PX / scale;
    if (localEdge <= localFeather) {
      fullLogoCrop.style.maskImage = "linear-gradient(transparent, transparent)";
      fullLogoCrop.style.webkitMaskImage = "linear-gradient(transparent, transparent)";
    } else {
      const mask = `linear-gradient(to bottom, #000 0, #000 ${(localEdge - localFeather).toFixed(1)}px, transparent ${localEdge.toFixed(1)}px, transparent 100%)`;
      fullLogoCrop.style.maskImage = mask;
      fullLogoCrop.style.webkitMaskImage = mask;
    }
  }

  function updateNav(p) {
    const span = 1 - REVEAL_PHASE_END;
    const navT = span > 0 ? clamp01((p - REVEAL_PHASE_END) / span) : (p >= 1 ? 1 : 0);
    const inNavbarPhase = p >= REVEAL_PHASE_END;

    updateEdgeCrop(p);

    stage.style.backgroundColor = inNavbarPhase ? `rgb(${BG_DEEP.join(", ")})` : "";
    const navHeightPx = parseFloat(getComputedStyle(siteNav).height) || 72;
    const curtainHeightPx = inNavbarPhase ? lerp(window.innerHeight, navHeightPx, navT) : window.innerHeight;
    navCurtain.style.height = inNavbarPhase ? `${curtainHeightPx}px` : "0px";

    updateFullLogoCrop(p, navT, inNavbarPhase, curtainHeightPx);

    siteNav.style.setProperty("--nav-line", String(clamp01((navT - 0.85) / 0.15) * 0.14));

    const actionsOpacity = clamp01((navT - 0.45) / 0.4);
    navActions.style.setProperty("--nav-actions", String(actionsOpacity));
    navActions.classList.toggle("ready", actionsOpacity > 0.6);
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
    img.onerror = () => loadingEl.remove();
    img.src = frameSrc(DESKTOP_DIR, FRAME_COUNT - 1);
    heroIntro.classList.add("is-static");
    lines.forEach((l) => { l.style.opacity = "0"; });

    // No scroll-driven animation here, so the nav just appears already docked
    // alongside the static logo (stage background stays black — there's no
    // scroll narrative here to motivate the curtain's slide-up reveal).
    setupCrops();
    siteNav.style.setProperty("--nav-line", "0.14");
    const navHeightPx = parseFloat(getComputedStyle(siteNav).height) || 72;
    navCurtain.style.height = `${navHeightPx}px`;
    edgeCrop.style.opacity = "1";
    edgeCrop.style.transform = "translate(0px, 0px) scale(1)";
    navActions.style.setProperty("--nav-actions", "1");
    navActions.classList.add("ready");
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

    setupCrops();

    const st = ScrollTrigger.create({
      trigger: pinSection,
      start: "top top",
      end: () => `+=${window.innerHeight * TOTAL_VH}`,
      scrub: true,
      pin: true,
      anticipatePin: 1,
      invalidateOnRefresh: true,
      onUpdate: (self) => {
        progressBar.style.width = `${self.progress * 100}%`;
        renderAtProgress(self.progress);
        updateCopy(self.progress);
        updateNav(self.progress);
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
        updateNav(currentScrollProgress());
        ScrollTrigger.refresh();
      });
    });
  }

  menuToggle.addEventListener("click", () => {
    const open = navMenu.classList.toggle("open");
    menuToggle.setAttribute("aria-expanded", String(open));
    menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    navMenu.setAttribute("aria-hidden", String(!open));
  });

  playHeroEntrance();

  if (reducedMotion) {
    initStaticFallback();
  } else {
    initAnimated();
  }
})();
