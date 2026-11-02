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

  // One-time layout: size the crop box to its docked (navbar) size, and
  // scale/offset the full-frame img inside it so EDGE_CROP_RECT lines up
  // exactly with the box. From here on, only `transform` on .edge-crop
  // itself changes — scaling this base layout up/down as a unit, exactly
  // like a sprite crop.
  function setupEdgeCrop() {
    const k = DOCK_CROP_W / EDGE_CROP_RECT.w;
    edgeCrop.style.width = `${DOCK_CROP_W}px`;
    edgeCrop.style.height = `${DOCK_CROP_H}px`;
    edgeCropImg.style.width = `${2560 * k}px`;
    edgeCropImg.style.height = `${1440 * k}px`;
    edgeCropImg.style.left = `${-EDGE_CROP_RECT.x * k}px`;
    edgeCropImg.style.top = `${-EDGE_CROP_RECT.y * k}px`;
  }

  // Where EDGE_CROP_RECT lands on screen if the full frame were drawn with
  // drawCoverShrink(img, shrink) right now — i.e. exactly how the canvas
  // itself is rendering that region. Used to keep the crop perfectly
  // aligned with the canvas during the reveal phase, and as the fly
  // animation's continuity anchor once the canvas starts fading.
  function edgeCropRectForShrink(shrink) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.width, ch = canvas.height;
    const s = Math.max(cw / 2560, ch / 1440) * shrink;
    const sCss = s / dpr;
    const ox = (cw - 2560 * s) / 2 / dpr;
    const oy = (ch - 1440 * s) / 2 / dpr;
    return {
      x: ox + EDGE_CROP_RECT.x * sCss,
      y: oy + EDGE_CROP_RECT.y * sCss,
      w: EDGE_CROP_RECT.w * sCss,
    };
  }

  function shrinkForProgress(p) {
    const span = REVEAL_PHASE_END - FRAME_PHASE_SHARE;
    const t = span > 0 ? (p - FRAME_PHASE_SHARE) / span : 1;
    return 1 - (1 - REVEAL_SHRINK_TO) * clamp01(t);
  }

  function updateEdgeCrop(p) {
    if (p < FRAME_PHASE_SHARE) {
      edgeCrop.style.opacity = "0";
      return;
    }
    edgeCrop.style.opacity = "1";

    const dockLeft = parseFloat(getComputedStyle(edgeCrop).left) || 24;
    const dockTop = parseFloat(getComputedStyle(edgeCrop).top) || 24;

    let rect, S;
    if (p <= REVEAL_PHASE_END) {
      rect = edgeCropRectForShrink(shrinkForProgress(p));
      S = rect.w / DOCK_CROP_W;
    } else {
      const boundary = edgeCropRectForShrink(REVEAL_SHRINK_TO);
      const span = 1 - REVEAL_PHASE_END;
      const navT = span > 0 ? clamp01((p - REVEAL_PHASE_END) / span) : 1;
      S = lerp(boundary.w / DOCK_CROP_W, 1, navT);
      rect = {
        x: lerp(boundary.x, dockLeft, navT),
        y: lerp(boundary.y, dockTop, navT),
      };
    }
    const tx = rect.x - dockLeft;
    const ty = rect.y - dockTop;
    edgeCrop.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${S.toFixed(4)})`;
  }

  // The rest of the logo (spine + "CHIROPRACTIC") fades out while a black
  // curtain — initially covering the whole stage — slides its bottom edge
  // up to the navbar's height, "sticking" there and revealing the deep blue
  // stage background as it recedes. The canvas renders ABOVE the curtain
  // (see .pin-section's z-index) so the fading logo is visible against the
  // still-black curtain as it passes — but it must never appear sitting on
  // the already-revealed blue. Masking the canvas to the exact same edge as
  // the curtain, with a soft feather right at that line, keeps the two in
  // perfect lockstep: a gentle dissolve exactly where the wipe is, and
  // nothing left behind once it's passed.
  const MASK_FEATHER_PX = 110;
  function updateNav(p) {
    const span = 1 - REVEAL_PHASE_END;
    const navT = span > 0 ? clamp01((p - REVEAL_PHASE_END) / span) : (p >= 1 ? 1 : 0);
    const inNavbarPhase = p >= REVEAL_PHASE_END;

    updateEdgeCrop(p);

    stage.style.backgroundColor = inNavbarPhase ? `rgb(${BG_DEEP.join(", ")})` : "";
    const navHeightPx = parseFloat(getComputedStyle(siteNav).height) || 72;
    const curtainHeightPx = inNavbarPhase ? lerp(window.innerHeight, navHeightPx, navT) : window.innerHeight;
    navCurtain.style.height = inNavbarPhase ? `${curtainHeightPx}px` : "0px";

    if (!inNavbarPhase) {
      canvas.style.maskImage = "";
      canvas.style.webkitMaskImage = "";
    } else if (curtainHeightPx <= MASK_FEATHER_PX) {
      // Too close to the navbar's own height for the feather math below to
      // make sense (it would let a sliver bleed through near y=0) — by this
      // point the dissolve has already fully played out higher up, so just
      // hide the canvas outright.
      canvas.style.maskImage = "linear-gradient(transparent, transparent)";
      canvas.style.webkitMaskImage = "linear-gradient(transparent, transparent)";
    } else {
      const edge = curtainHeightPx;
      const mask = `linear-gradient(to bottom, #000 0, #000 ${edge - MASK_FEATHER_PX}px, transparent ${edge}px, transparent 100%)`;
      canvas.style.maskImage = mask;
      canvas.style.webkitMaskImage = mask;
    }

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
    setupEdgeCrop();
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

    setupEdgeCrop();

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
