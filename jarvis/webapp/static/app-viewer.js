// Приложение из каталога внутри Atom: окно со встроенной страницей (iframe) — «Ценники» и другие свои программы
// открываются, не уходя с дашборда. Если сайт запрещает встраивание или нужен весь экран — «↗» открывает его
// в новой вкладке. Работает и у владельца, и в кабинете оператора.
import { esc } from "./markdown.js?v=24";
import { appIcon, embeddable } from "./apps-catalog.js?v=24";

export class AppViewer {
  constructor(root) {
    this.root = root;
    root.innerHTML = `<div class="av-top">
        <span class="av-ic" data-el="ic"></span><b data-el="name"></b><small class="muted" data-el="host"></small>
        <a class="btn ghost" data-el="ext" target="_blank" rel="noopener" title="Открыть в новой вкладке">↗ В новой вкладке</a>
        <button class="btn ghost" data-act="close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button></div>
      <div class="av-frame" data-el="frame"></div>`;
    this.el = (n) => root.querySelector(`[data-el="${n}"]`);
    root.addEventListener("click", (e) => { if (e.target.closest("[data-act=close]")) this.close(); });
  }

  get isOpen() { return !this.root.classList.contains("hidden"); }

  open(app) {
    if (!embeddable(app.url)) { window.open(app.url, "_blank", "noopener"); return; }
    const url = new URL(app.url);
    this.el("ic").textContent = appIcon(app);
    this.el("name").textContent = app.name;
    this.el("host").textContent = url.host;
    this.el("ext").href = url.href;
    // своё происхождение у приложения (allow-same-origin относится к его сайту, не к Atom): хранилище браузера,
    // печать, «Поделиться» и загрузка файлов (PDF, PNG) работают как в отдельной вкладке
    this.el("frame").innerHTML = `<iframe src="${esc(url.href)}" title="${esc(app.name)}" referrerpolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
      allow="clipboard-write; web-share; fullscreen"></iframe>
      <p class="av-hint muted">Если страница не появилась — сайт не разрешает встраивание: нажмите «↗ В новой вкладке».</p>`;
    this.root.classList.remove("hidden");
    document.body.classList.add("fw-on");
  }

  close() {
    this.el("frame").innerHTML = "";
    this.root.classList.add("hidden");
    document.body.classList.remove("fw-on");
  }
}
