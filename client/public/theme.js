// Apply the saved theme before first paint (external file: the CSP blocks inline scripts).
try { var t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
