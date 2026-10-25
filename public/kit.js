/* Knightfall Kit — motion behaviors (no libraries). data-attribute powered. */
window.Kit = (function () {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let io = null, progress = null, raf = 0, primed = false;
  /* First page load plays the entrance choreography; afterwards the app
     re-renders its whole DOM on every click, so reveals settle instantly
     to avoid replay-flicker on each interaction. */
  setTimeout(() => { primed = true; }, 2500);

  function scanReveals(root) {
    const els = root.querySelectorAll('[data-reveal]:not(.is-in),[data-reveal-group]:not(.is-in)');
    if (reduced) { els.forEach(el => el.classList.add('is-in')); return; }
    if (primed) {
      els.forEach(el => { el.classList.add('kf-instant', 'is-in'); el.querySelectorAll('[data-count]').forEach(countUp); });
      return;
    }
    els.forEach(el => {
      if (el.dataset.kfWatch) return;
      el.dataset.kfWatch = '1';
      io.observe(el);
    });
  }

  function splitWords(el) {
    if (el.dataset.kfSplit || reduced) return;
    el.dataset.kfSplit = '1';
    const walk = (node) => {
      [...node.childNodes].forEach(ch => {
        if (ch.nodeType === 3) {
          const frag = document.createDocumentFragment();
          ch.textContent.split(/(\s+)/).forEach(tok => {
            if (!tok.trim()) { frag.appendChild(document.createTextNode(tok)); return; }
            const wrap = document.createElement('span');
            wrap.className = 'kf-word';
            wrap.textContent = tok;
            frag.appendChild(wrap);
          });
          node.replaceChild(frag, ch);
        } else if (ch.nodeType === 1 && ch.tagName !== 'BR') walk(ch);
      });
    };
    walk(el);
    el.querySelectorAll('.kf-word').forEach((w, i) => {
      w.style.display = 'inline-block';
      w.style.overflow = 'hidden';
      w.style.transform = 'translateY(110%)';
      w.style.transition = `transform calc(0.8s * var(--speed)) var(--ease) ${i * 0.07}s`;
      requestAnimationFrame(() => requestAnimationFrame(() => { w.style.transform = 'none'; }));
    });
  }

  function countUp(el) {
    if (el.dataset.kfCounted) return;
    el.dataset.kfCounted = '1';
    const target = parseFloat(el.dataset.count) || 0;
    const suffix = el.dataset.suffix || '';
    if (reduced || primed || !target) { el.textContent = target + suffix; return; }
    const t0 = performance.now(), dur = 1100;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * e) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function onProgress() {
    if (!progress) progress = document.querySelector('.scroll-progress');
    if (!progress) return;
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    const f = max > 0 ? (h.scrollTop || document.body.scrollTop) / max : 0;
    progress.style.transform = `scaleX(${Math.min(1, Math.max(0, f))})`;
  }

  function init() {
    io = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        const el = en.target;
        io.unobserve(el);
        el.classList.add('is-in');
        if (el.hasAttribute('data-reveal-group')) el.querySelectorAll('[data-count]').forEach(countUp);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { onProgress(); raf = 0; }); }, { passive: true });
    onProgress();
  }

  function refresh() {
    const root = document.body;
    scanReveals(root);
    document.querySelectorAll('[data-split]:not([data-kf-split])').forEach(splitWords);
    document.querySelectorAll('[data-reveal].is-in [data-count], [data-reveal-group].is-in [data-count]').forEach(countUp);
    onProgress();
  }

  if (document.readyState !== 'loading') init();
  else addEventListener('DOMContentLoaded', init);

  return { refresh, setSpeed: (s) => { if (s > 0) document.documentElement.style.setProperty('--speed', s); } };
})();
