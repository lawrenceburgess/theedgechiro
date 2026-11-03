(() => {
  const FRAME_COUNT = 121;
  const DESKTOP_DIR = "frames/desktop";
  const MOBILE_DIR = "frames/mobile";
  const PIN_VH_MULTIPLIER = 4.5; // screen heights spent playing the 121 frames
  const REVEAL_VH_MULTIPLIER = 0.2; // extra screen heights spent shrinking to reveal the full wordmark
  const NAVBAR_VH_MULTIPLIER = 1.3; // extra screen heights spent flying "THE EDGE" into the navbar
  const TOTAL_VH = PIN_VH_MULTIPLIER + REVEAL_VH_MULTIPLIER + NAVBAR_VH_MULTIPLIER;
  const FRAME_PHASE_SHARE = PIN_VH_MULTIPLIER / TOTAL_VH;
  const REVEAL_PHASE_END = (PIN_VH_MULTIPLIER + REVEAL_VH_MULTIPLIER) / TOTAL_VH;
  const REVEAL_SHRINK_TO = 0.85;
  const LOAD_CONCURRENCY = 6;
  const DR_PARALLAX_SPEED = 1.4; // how many times faster the photo drifts than the page while its frame is in view

  const BG_DEEP = [14, 22, 36]; // dark muted blue revealed as the black curtain slides up

  // Pixel bounds of "THE EDGE" within frame_0121 desktop (2560x1440),
  // measured directly off the baked wordmark — see the crop verification
  // done while building this feature. DOCK_CROP_W is its on-screen width
  // once docked in the navbar; height follows the crop's own aspect ratio.
  const EDGE_CROP_RECT = { x: 890, y: 985, w: 325, h: 63 };
  const DOCK_CROP_W = 108; // "THE EDGE"'s on-screen width once docked in the navbar

  // Pixel bounds of the whole logo (spine + full wordmark) in the same
  // frame, similarly measured. A single crop of this whole region flies to
  // the navbar as one piece; a mask (see buildLogoMask) keeps EDGE_CROP_RECT
  // always opaque within it while everything else fades.
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
  const logoFly = document.getElementById("logo-fly");
  const logoFlyImg = logoFly.querySelector("img");
  const navActions = document.getElementById("nav-actions");
  const menuToggle = document.getElementById("menu-toggle");
  const navMenu = document.getElementById("nav-menu");

  const drPhotoFrame = document.querySelector(".dr-photo-frame");
  const drPhoto = drPhotoFrame ? drPhotoFrame.querySelector("img") : null;

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

  // Calibrated so EDGE_CROP_RECT, at docked scale (1), renders at
  // DOCK_CROP_W px wide — the reference zoom level for logo-fly's whole
  // base layout.
  const CROP_K = DOCK_CROP_W / EDGE_CROP_RECT.w;

  // "THE EDGE" sits well inside FULL_LOGO_RECT (below the spine, and not
  // flush with its left edge), not at the crop's own top-left corner — so
  // docking the *container* at the navbar position is not the same as
  // docking *the text* there. This is how far "THE EDGE" sits from the
  // container's top-left once laid out at CROP_K, used to pull the
  // container's own anchor back by that amount so the text itself — not
  // the container — ends up at (DOCK_LEFT, DOCK_TOP).
  const EDGE_OFFSET_X = (EDGE_CROP_RECT.x - FULL_LOGO_RECT.x) * CROP_K;
  const EDGE_OFFSET_Y = (EDGE_CROP_RECT.y - FULL_LOGO_RECT.y) * CROP_K;
  const DOCK_TOP = 25;
  const dockLeftForViewport = () => (window.innerWidth >= 700 ? 48 : 24);

  // One-time (+ on resize) layout: size logo-fly to FULL_LOGO_RECT at
  // CROP_K, scale/offset the full-frame img inside it so that rect lines up
  // exactly with the box, and position the container so "THE EDGE" (not
  // the container's own corner) lands at the navbar dock point. From here
  // on, only `transform` (position/scale) and `mask-image` (which region
  // fades) change per scroll frame.
  function setupLogoFly() {
    logoFly.style.width = `${FULL_LOGO_RECT.w * CROP_K}px`;
    logoFly.style.height = `${FULL_LOGO_RECT.h * CROP_K}px`;
    logoFlyImg.style.width = `${2560 * CROP_K}px`;
    logoFlyImg.style.height = `${1440 * CROP_K}px`;
    logoFlyImg.style.left = `${-FULL_LOGO_RECT.x * CROP_K}px`;
    logoFlyImg.style.top = `${-FULL_LOGO_RECT.y * CROP_K}px`;
    logoFly.style.left = `${dockLeftForViewport() - EDGE_OFFSET_X}px`;
    logoFly.style.top = `${DOCK_TOP - EDGE_OFFSET_Y}px`;
  }

  // Where FULL_LOGO_RECT lands on screen if the full frame were drawn with
  // drawCoverShrink(img, shrink) right now — i.e. exactly how the canvas
  // itself is rendering it. Used as the fly animation's continuity anchor
  // (navT=0) once the canvas hands off to logo-fly.
  function cropRectForShrink(shrink) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.width, ch = canvas.height;
    const s = Math.max(cw / 2560, ch / 1440) * shrink;
    const sCss = s / dpr;
    const ox = (cw - 2560 * s) / 2 / dpr;
    const oy = (ch - 1440 * s) / 2 / dpr;
    return {
      x: ox + FULL_LOGO_RECT.x * sCss,
      y: oy + FULL_LOGO_RECT.y * sCss,
      w: FULL_LOGO_RECT.w * sCss,
    };
  }

  // navT=0 exactly matches how the canvas rendered FULL_LOGO_RECT at the
  // reveal phase's final shrink; navT=1 is fully docked (identity
  // transform, since logo-fly's own base layout already *is* its docked
  // appearance).
  function flyTransform(navT, dockLeft, dockTop) {
    const boundary = cropRectForShrink(REVEAL_SHRINK_TO);
    const scaleFrom = boundary.w / (FULL_LOGO_RECT.w * CROP_K);
    const txFrom = boundary.x - dockLeft;
    const tyFrom = boundary.y - dockTop;
    return {
      scale: lerp(scaleFrom, 1, navT),
      tx: lerp(txFrom, 0, navT),
      ty: lerp(tyFrom, 0, navT),
    };
  }

  // A mask built from two flat rects in logo-fly's own local (untransformed)
  // coordinate space, so it's completely independent of the element's
  // current transform or the curtain's screen position — no backward-
  // solved coordinates to get wrong. The "THE EDGE" rect always stays at
  // full opacity; the rect behind it covers the whole crop at `fadeOpacity`.
  // White+fill-opacity gives the same effective mask value (luminance ×
  // alpha) under either luminance- or alpha-based mask interpretation, so
  // this renders consistently without needing to pick one.
  function buildLogoMask(fadeOpacity) {
    const w = FULL_LOGO_RECT.w * CROP_K, h = FULL_LOGO_RECT.h * CROP_K;
    const ex = (EDGE_CROP_RECT.x - FULL_LOGO_RECT.x) * CROP_K;
    const ey = (EDGE_CROP_RECT.y - FULL_LOGO_RECT.y) * CROP_K;
    const ew = EDGE_CROP_RECT.w * CROP_K, eh = EDGE_CROP_RECT.h * CROP_K;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
      + `<rect width="${w}" height="${h}" fill="#fff" fill-opacity="${fadeOpacity.toFixed(3)}"/>`
      + `<rect x="${ex.toFixed(2)}" y="${ey.toFixed(2)}" width="${ew.toFixed(2)}" height="${eh.toFixed(2)}" fill="#fff"/>`
      + `</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }

  // spine + "CHIROPRACTIC" fade out (via the mask above) over a plain navT
  // curve while logo-fly flies — visible against the still-black curtain.
  // The curtain itself doesn't start revealing blue until CURTAIN_START,
  // safely after FADE_END, so the fading logo never ends up ghosted on the
  // revealed blue. "THE EDGE", always opaque within the mask, survives the
  // whole trip — and since it's the same element as everything else, it's
  // physically impossible for it to drift out of sync with the rest.
  const FADE_END = 0.4;
  const CURTAIN_START = 0.45;
  function updateLogoFly(navT, inNavbarPhase) {
    canvas.style.opacity = inNavbarPhase ? "0" : "1";
    if (!inNavbarPhase) {
      logoFly.style.opacity = "0";
      return;
    }
    logoFly.style.opacity = "1";

    const dockLeft = parseFloat(getComputedStyle(logoFly).left) || 24;
    const dockTop = parseFloat(getComputedStyle(logoFly).top) || 25;
    const { scale, tx, ty } = flyTransform(navT, dockLeft, dockTop);
    logoFly.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;

    const mask = buildLogoMask(1 - clamp01(navT / FADE_END));
    logoFly.style.maskImage = mask;
    logoFly.style.webkitMaskImage = mask;
  }

  function updateNav(p) {
    const span = 1 - REVEAL_PHASE_END;
    const navT = span > 0 ? clamp01((p - REVEAL_PHASE_END) / span) : (p >= 1 ? 1 : 0);
    const inNavbarPhase = p >= REVEAL_PHASE_END;

    updateLogoFly(navT, inNavbarPhase);

    stage.style.backgroundColor = inNavbarPhase ? `rgb(${BG_DEEP.join(", ")})` : "";
    const navHeightPx = parseFloat(getComputedStyle(siteNav).height) || 72;
    const curtainT = clamp01((navT - CURTAIN_START) / (1 - CURTAIN_START));
    const curtainHeightPx = inNavbarPhase ? lerp(window.innerHeight, navHeightPx, curtainT) : window.innerHeight;
    navCurtain.style.height = inNavbarPhase ? `${curtainHeightPx}px` : "0px";

    siteNav.style.setProperty("--nav-line", String(clamp01((navT - 0.92) / 0.08) * 0.14));

    const actionsOpacity = clamp01((navT - 0.55) / 0.35);
    navActions.style.setProperty("--nav-actions", String(actionsOpacity));
    navActions.classList.toggle("ready", actionsOpacity > 0.6);
  }

  // Deliberately overscales the photo to DR_PARALLAX_SPEED x the frame's
  // own height (well beyond what its natural aspect ratio would need), and
  // centers it horizontally — that extra size is what gives the image room
  // to travel faster than the frame itself as the page scrolls.
  function layoutDrPhoto() {
    if (!drPhoto || !drPhotoFrame || !drPhoto.naturalWidth) return;
    const h = drPhotoFrame.clientHeight * DR_PARALLAX_SPEED;
    const w = h * (drPhoto.naturalWidth / drPhoto.naturalHeight);
    drPhoto.style.width = `${w}px`;
    drPhoto.style.height = `${h}px`;
    drPhoto.style.left = "50%";
    drPhoto.style.marginLeft = `${-w / 2}px`;
  }

  // How far the oversized photo can travel before its bottom edge reaches
  // the frame's bottom edge.
  function drPanRange() {
    if (!drPhotoFrame) return 0;
    return drPhotoFrame.clientHeight * (DR_PARALLAX_SPEED - 1);
  }

  // Pans the photo from top to bottom of its own (oversized) height over
  // the scroll distance exactly equal to one frame-height — frame-top at
  // viewport-center to frame-bottom at viewport-center — read live off
  // getBoundingClientRect() every tick instead of GSAP's cached trigger
  // start/end. A ScrollTrigger-scrub version of this kept getting its
  // start/end corrupted by the *later*, unrelated global refresh the pin
  // section's resize handler triggers (reproducible: individually
  // refreshing the trigger gave correct bounds, but the very next global
  // ScrollTrigger.refresh() silently reset them to a stale, much-too-small
  // range left over from before the pin's spacer existed) — rather than
  // depend on that ordering, this just recomputes from the DOM directly,
  // the same way renderAtProgress/updateNav already do.
  let drPhotoReady = false;
  function updateDrParallax() {
    if (reducedMotion || !drPhotoReady) return;
    const rect = drPhotoFrame.getBoundingClientRect();
    const t = clamp01((window.innerHeight / 2 - rect.top) / rect.height);
    drPhoto.style.transform = `translateY(${(-drPanRange() * t).toFixed(2)}px)`;
  }

  function setupDrParallax() {
    if (reducedMotion || !drPhoto || !drPhotoFrame) return;
    const start = () => {
      layoutDrPhoto();
      drPhotoReady = true;
      updateDrParallax();
    };
    if (drPhoto.complete && drPhoto.naturalWidth) start();
    else drPhoto.addEventListener("load", start, { once: true });
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
    setupLogoFly();
    siteNav.style.setProperty("--nav-line", "0.14");
    const navHeightPx = parseFloat(getComputedStyle(siteNav).height) || 72;
    navCurtain.style.height = `${navHeightPx}px`;
    logoFly.style.opacity = "1";
    logoFly.style.transform = "translate(0px, 0px) scale(1)";
    const dockedMask = buildLogoMask(0);
    logoFly.style.maskImage = dockedMask;
    logoFly.style.webkitMaskImage = dockedMask;
    navActions.style.setProperty("--nav-actions", "1");
    navActions.classList.add("ready");
  }

  function initAnimated() {
    sizeCanvas();
    loadSequence(pickDir());
    loadRevealImage();

    gsap.registerPlugin(ScrollTrigger);

    const lenis = new Lenis({ smoothWheel: true, duration: 1.1 });
    lenis.on("scroll", () => {
      ScrollTrigger.update();
      updateDrParallax();
    });
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);

    setupLogoFly();
    setupDrParallax();

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
        setupLogoFly(); // dockLeftForViewport() may have crossed the 700px breakpoint
        renderAtProgress(currentScrollProgress());
        updateNav(currentScrollProgress());
        layoutDrPhoto();
        updateDrParallax();
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
