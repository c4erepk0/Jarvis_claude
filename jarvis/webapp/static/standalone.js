// Режим «только iPhone»: Jarvis целиком в Safari, без сервера.
// Ключи хранятся только на этом устройстве (localStorage). Память — GitHub-репозиторий с хранилищем Obsidian.
import { Jarvis } from "./core/jarvis.js";
import { GitHub } from "./core/github.js";
import { GitHubStore, LocalStore } from "./core/vault.js";

// Официальный SDK Anthropic для браузера (закреплённая версия)
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";
const KEY = "jarvis.settings";

export const DEFAULTS = {
  title: "сэр", name: "", city: "Москва", lat: 55.7558, lon: 37.6173, currency: "RUB",
  anthropicKey: "", model: "claude-opus-5-5", effort: "low", webSearch: true,
  githubToken: "", vaultRepo: "", vaultBranch: "main", statsTokens: {}, wakeWord: "джарвис", voiceName: "",
};

export function loadSettings() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; } catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
export function hasSettings() { try { return localStorage.getItem(KEY) !== null; } catch { return false; } }
export function clearSettings() { try { localStorage.removeItem(KEY); } catch { /* приватный режим */ } }

// Кэш содержимого заметок по sha блоба: при следующем запуске качаются только изменённые файлы.
class BlobCache {
  async db() {
    if (!this._db) {
      this._db = await new Promise((resolve) => {
        const req = indexedDB.open("jarvis-blobs", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("b");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
    }
    return this._db;
  }
  async get(sha) {
    const db = await this.db();
    if (!db) return null;
    return new Promise((resolve) => {
      const req = db.transaction("b").objectStore("b").get(sha);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  }
  async set(sha, text) {
    const db = await this.db();
    if (!db) return;
    db.transaction("b", "readwrite").objectStore("b").put(text, sha);
  }
}

export async function vaultTemplate() {
  const r = await fetch("static/vault-template.json?v=11");
  return r.ok ? r.json() : {};
}

export async function createLocal(settings) {
  const github = settings.githubToken ? new GitHub(settings.githubToken) : null;
  const store = github && settings.vaultRepo
    ? new GitHubStore(github, settings.vaultRepo, settings.vaultBranch || "main", new BlobCache())
    : new LocalStore("jarvis-demo", await vaultTemplate());
  const clientFactory = async () => {
    const mod = await import(SDK_URL);
    const Anthropic = mod.default || mod.Anthropic;
    return new Anthropic({ apiKey: settings.anthropicKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  };
  const j = new Jarvis(settings, { store, github, clientFactory });
  await j.init();
  return j;
}

// Проверка доступа к репозиторию памяти; если его нет — пробуем создать приватный.
export async function checkVaultRepo(token, repo) {
  const gh = new GitHub(token);
  try {
    const info = await gh.request("GET", `/repos/${repo}`);
    if (info.permissions && !info.permissions.push) throw new Error("у токена нет права записи в этот репозиторий");
    return { branch: info.default_branch || "main", created: false, private: info.private };
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const [owner, name] = repo.split("/");
  const me = await gh.user();
  if (me.login.toLowerCase() !== owner.toLowerCase()) throw new Error("репозиторий не найден — создайте его на GitHub");
  try {
    await gh.request("POST", "/user/repos", { body: { name, private: true, auto_init: true, description: "Память Jarvis (Obsidian)" } });
  } catch {
    throw new Error(`репозиторий ${repo} не найден, и токен не может его создать — создайте приватный репозиторий вручную`);
  }
  return { branch: "main", created: true, private: true };
}

// Пустое хранилище → кладём стартовую структуру (существующие заметки не трогаем).
export async function seedVault(j) {
  const files = await vaultTemplate();
  let n = 0;
  for (const [path, text] of Object.entries(files)) {
    if (j.vault.exists(path)) continue;
    await j.vault.write(path, text, `Jarvis: стартовая структура (${path})`);
    n++;
  }
  return n;
}

export function needsSeed(j) { return !j.vault.exists("Jarvis/Profile.md") && !j.vault.exists("Tasks/Inbox.md"); }
