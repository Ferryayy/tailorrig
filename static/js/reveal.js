(function () {
  const initializeReveal = () => {
    const elements = Array.from(document.querySelectorAll("[data-reveal]"));
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!elements.length || prefersReducedMotion || !("IntersectionObserver" in window)) {
      return;
    }

    elements.forEach((element) => {
      const delay = Number.parseInt(element.dataset.revealDelay || "0", 10);
      element.style.setProperty("--reveal-delay", `${Math.max(delay, 0)}ms`);
    });

    document.documentElement.classList.add("reveal-ready");

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }

          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      {
        rootMargin: "0px 0px -8% 0px",
        threshold: 0.12,
      },
    );

    window.requestAnimationFrame(() => {
      document.documentElement.classList.add("reveal-active");
      elements.forEach((element) => observer.observe(element));
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeReveal, { once: true });
  } else {
    initializeReveal();
  }
})();
