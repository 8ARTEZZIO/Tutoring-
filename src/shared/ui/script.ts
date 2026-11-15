/** Public progressive enhancement (pages work fully without it). Served from /assets/app.js. */
export const PUBLIC_JS = `(function(){
  "use strict";
  // Sticky mobile CTA: shown only once the main booking button has scrolled out of view.
  var main = document.querySelector("[data-main-cta]");
  var bar = document.querySelector("[data-sticky-cta]");
  if (main && bar && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var above = e.boundingClientRect.top < 0;
        bar.hidden = e.isIntersecting || !above;
      });
    });
    io.observe(main);
  }
  // Prevent double submission; the server is idempotent anyway.
  document.querySelectorAll("form[data-once]").forEach(function (form) {
    form.addEventListener("submit", function () {
      var btn = form.querySelector("button[type=submit]");
      if (btn) {
        setTimeout(function () { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }, 0);
        var label = btn.getAttribute("data-busy-label");
        if (label) btn.textContent = label;
      }
    });
  });
  // Copy buttons.
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.hidden = false;
    btn.addEventListener("click", function () {
      var target = document.getElementById(btn.getAttribute("data-copy"));
      if (!target) return;
      var text = target.value || target.textContent || "";
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () {
          var old = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = old; }, 1800);
        });
      } else if (target.select) { target.select(); document.execCommand("copy"); }
    });
  });
})();`;
