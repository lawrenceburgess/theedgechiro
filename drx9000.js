(() => {
  const FRAME_COUNT = 177; // orbit+push-in -> crossfade -> vertebrae separation, extracted at 16fps
  const DESKTOP_DIR = "frames/drx9000/desktop";
  const LOAD_CONCURRENCY = 6;

  // Scroll distance is built from three screen-height budgets rather than
  // one flat multiplier, so the sequence can *hold* on a single frame for a
  // stretch (while the subheading fades in) instead of scrubbing frames the
  // whole time:
  //   VH_INTRO  - orbit/push-in through the crossfade into the vertebrae shot
  //   VH_HOLD   - frozen on the first (compressed/red) vertebra frame while
  //               the subheading fades in, so the text finishes appearing
  //               before anything in the shot moves again
  //   VH_MOTION - the red -> purple separation itself, scrubbed across more
  //               screens than before so it reads as visibly slower
  const VH_INTRO = 4.4;
  const VH_HOLD = 1.0;
  const VH_MOTION = 2.0;
  const TOTAL_VH = VH_INTRO + VH_HOLD + VH_MOTION;

  const P_INTRO_END = VH_INTRO / TOTAL_VH; // crossfade resolves, hold begins
  const P_HOLD_END = (VH_INTRO + VH_HOLD) / TOTAL_VH; // subheading fully visible, motion begins

  // 0-indexed frame where the crossfade dissolve has resolved to the
  // vertebrae shot (combined video: segAB+crossfade run to ~8.04s of 11.08s
  // at 16fps) — this is the frame held during VH_HOLD and the motion
  // segment's start frame.
  const CROSSFADE_END_FRAME = 129;
  const LAST_FRAME = FRAME_COUNT - 1;

  // Fade windows as [fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd], as a
  // fraction of this section's own scroll progress — matches the .copy .line
  // triangle-window pattern already used by the first hero in main.js.
  // The headline's words stagger in one at a time (see WORD_STAGGER below)
  // but all share this same fade-out, finishing well before the crossfade
  // starts. The subheading's fade-in is tied directly to the hold segment —
  // it starts the moment the hold begins and finishes exactly as the hold
  // ends, so the vertebrae only start separating once the text has fully
  // appeared. Subheading + button then hold through the end of the section
  // (fade-out end set past 1 since progress never reaches it, so there's
  // nothing left to fade into).
  const HEADLINE_FADEOUT = [3.12 / TOTAL_VH, 3.60 / TOTAL_VH];
  const WORD_STAGGER = 0.15 / TOTAL_VH; // scroll-progress offset between each word's own fade-in start
  const WORD_FADEIN_DUR = 0.3 / TOTAL_VH; // each word's own fade-in ramp length
  const SUBHEAD_WINDOW = [P_INTRO_END, P_HOLD_END, 1.05, 1.05];

  const canvas = document.getElementById("drx-canvas");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("drx-stage");
  const pinSection = document.getElementById("drx-pin-section");
  const loadingEl = document.getElementById("drx-loading-indicator");
  const scrim = document.getElementById("drx-scrim");
  const words = Array.from(document.querySelectorAll("#drx-headline .drx-word"));
  const lines = Array.from(document.querySelectorAll("#drx-copy .line"));

  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reducedMotion = reducedMotionQuery.matches;

  const seq = { images: new Array(FRAME_COUNT), loadedCount: 0, currentIndex: -1 };

  function frameSrc(i) {
    return `${DESKTOP_DIR}/frame_${String(i + 1).padStart(4, "0")}.webp`;
  }

  // CSS 100svh should be a stable "smallest viewport" height immune to a
  // mobile browser's address-bar show/hide, but in practice (reported on
  // Android Chrome, as a dead gap after Dr. Dunlap that doesn't resolve by
  // waiting — so not a loading delay, a real sizing mismatch) it isn't
  // reliable enough to pin a 6-screen scrub to. Setting the stage's height
  // directly from window.innerHeight at the moments that matter (init,
  // resize, orientation change) makes this section's own layout height and
  // the pin's scroll distance both trace back to the same JS-read number,
  // instead of one side trusting a CSS unit that can drift from it.
  function setStageHeight() {
    stage.style.height = `${window.innerHeight}px`;
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
  // On a portrait/mobile stage, pure cover crops almost the entire width
  // down to a heavily-zoomed center sliver, and pure contain (fit the whole
  // width in, letterboxed) was judged too small/too much black bar — so
  // portrait splits the difference: halfway between contain's scale and
  // cover's scale, a middle ground that shows much more width than cover
  // while filling noticeably more of the stage than contain.
  function drawCover(img) {
    const cw = canvas.width, ch = canvas.height;
    const portrait = ch > cw;
    let s;
    if (portrait) {
      const containS = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
      const coverS = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
      s = (containS + coverS) / 2;
    } else {
      s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    }
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
    let target;
    if (p < P_INTRO_END) {
      target = Math.round((p / P_INTRO_END) * CROSSFADE_END_FRAME);
    } else if (p < P_HOLD_END) {
      target = CROSSFADE_END_FRAME; // holding while the subheading fades in
    } else {
      const t = (p - P_HOLD_END) / (1 - P_HOLD_END);
      target = Math.round(CROSSFADE_END_FRAME + t * (LAST_FRAME - CROSSFADE_END_FRAME));
    }
    const idx = nearestLoaded(target);
    if (idx === -1 || idx === seq.currentIndex) return;
    drawCover(seq.images[idx]);
    seq.currentIndex = idx;
  }

  function updateCopy(p) {
    const [fc, fd] = HEADLINE_FADEOUT;
    let headlineOpacity = 0;
    words.forEach((word, i) => {
      const a = i * WORD_STAGGER, b = a + WORD_FADEIN_DUR;
      const o = triWindow(p, a, b, fc, fd);
      word.style.opacity = String(o);
      if (o > headlineOpacity) headlineOpacity = o;
    });
    const [sa, sb, sc, sd] = SUBHEAD_WINDOW;
    const subOpacity = triWindow(p, sa, sb, sc, sd);
    if (lines[0]) lines[0].style.opacity = String(subOpacity);
    // Headline and subheading/button now ride two different shots (opening
    // office scene, then the vertebrae-separation close-up), so the scrim
    // follows whichever of the two is actually on screen.
    if (scrim) scrim.style.opacity = String(Math.max(headlineOpacity, subOpacity));
    // Button shares the subheading's fade window and only accepts clicks
    // once mostly faded in (see .drx-cta.ready in styles.css).
    if (lines[1]) {
      lines[1].style.opacity = String(subOpacity);
      lines[1].classList.toggle("ready", subOpacity > 0.6);
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
    setStageHeight();
    sizeCanvas();
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { sizeCanvas(); drawCover(img); loadingEl.remove(); };
    img.onerror = () => loadingEl.remove();
    img.src = frameSrc(0);
    words.forEach((w) => { w.style.opacity = "1"; });
    lines.forEach((l) => {
      l.style.opacity = "1";
      l.style.position = "static";
      l.classList.add("ready");
    });
    if (scrim) scrim.style.opacity = "1";
  }

  function initAnimated() {
    setStageHeight();
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
      // stage.clientHeight now equals whatever setStageHeight() last set it
      // to (an explicit window.innerHeight snapshot, not the CSS 100svh
      // fallback), so this pin distance and the stage's own rendered height
      // always trace back to the same JS-read number.
      end: () => `+=${stage.clientHeight * TOTAL_VH}`,
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

    // Earlier sections' heights can still shift slightly after this trigger
    // is first measured — a late webfont swap (Jost) reflowing Dr. Dunlap's
    // text, or images finishing layout — which would otherwise leave this
    // trigger's start/end pinned to stale positions.
    window.addEventListener("load", () => ScrollTrigger.refresh());
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => ScrollTrigger.refresh());
    }

    // Mobile browsers (reported on Android Chrome) fire resize events for
    // the address bar hiding/showing as you scroll — a *height*-only change.
    // Reacting to those re-measures everything mid-scroll against a
    // transient viewport size, which is a well-known way to corrupt a
    // pinned ScrollTrigger's start/end. Only real resizes (width changes:
    // actual window resize, orientation change) should trigger a re-layout.
    let lastWidth = window.innerWidth;
    let resizeRaf = null;
    window.addEventListener("resize", () => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        setStageHeight();
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
