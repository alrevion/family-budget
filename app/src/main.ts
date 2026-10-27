// Точка входа. Шаг 8 плана: WebApp.ready()/expand(), глобальный 401,
// нижняя навигация из четырёх вкладок.
import { el, mount } from "./dom.js";
import { configureApi } from "./api.js";
import { bottomNav, type Tab } from "./nav.js";
import { renderOnboarding } from "./screens/onboarding.js";
import { renderHome } from "./screens/home.js";
import { renderFeed } from "./screens/feed.js";
import { renderGoals } from "./screens/goals.js";
import { renderShops } from "./screens/shops.js";
import { renderReport } from "./screens/report.js";
import { renderSessionExpired } from "./screens/session-expired.js";
import { openNewTransactionSheet } from "./screens/new-transaction.js";
import { showToast } from "./toast.js";
import { todayYmd } from "./format.js";
import { initTheme } from "./theme.js";
import { homeSkeleton } from "./states.js";
import { errorState } from "./states.js";
import * as api from "./api.js";

const root = document.getElementById("app");
if (!root) throw new Error("#app не найден");

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
// До первого рендера, иначе на кадр мигнёт системная тема вместо телеграмной.
initTheme();

let sessionExpired = false;

configureApi(tg?.initData ?? "", () => {
  if (sessionExpired) return;
  sessionExpired = true;
  mount(root, el("div", { class: "app-shell" }));
  renderSessionExpired(root.firstElementChild as HTMLElement);
});

// Deep link из cron-сообщения (план, шаг 15): t.me/<bot>/<app>?startapp=<YYYY-MM>
// открывает отчёт сразу на нужном месяце.
// Месяц приходит ДВУМЯ путями, и оба обязаны работать:
//   start_param — когда открыли по t.me-ссылке (фолбэк в sendWithAppButton);
//   ?month=     — когда нажали основную web_app-кнопку в сообщении отчёта.
// Раньше читался только start_param, поэтому основная кнопка месячного
// отчёта открывала главный экран вместо отчёта за нужный месяц.
const monthRe = /^\d{4}-\d{2}$/;
const startParam = tg?.initDataUnsafe?.start_param;
const monthFromQuery = new URLSearchParams(location.search).get("month");
const deepLinkMonth =
  startParam && monthRe.test(startParam)
    ? startParam
    : monthFromQuery && monthRe.test(monthFromQuery)
      ? monthFromQuery
      : undefined;

// Параметры запуска из web_app-кнопок ежедневного напоминания (src/cron.ts):
//   ?add=YYYY-MM-DD — открыть форму новой траты сразу на этом дне;
//   ?nospend=1      — «ничего не тратили», продлить тишину напоминаний.
// web_app-кнопка отдаёт их обычной query-строкой, не через start_param.
const launchParams = new URLSearchParams(location.search);

/**
 * Дата из ?add= принимается, только если это YYYY-MM-DD, не в будущем и не
 * старше 90 дней. Иначе параметр игнорируется и открывается обычная главная:
 * ссылка приходит извне, а форма с датой «за 2019 год» — мусор, а не догон.
 */
function launchDate(raw: string | null): string | undefined {
  if (raw === null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const today = todayYmd();
  const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return raw > today || raw < oldest ? undefined : raw;
}

let pendingAddDate = launchDate(launchParams.get("add"));

if (launchParams.has("nospend")) {
  void api
    .markNoSpend()
    .then(() => showToast("Хорошо, напомним попозже", "info"))
    .catch(() => showToast("Не удалось сохранить. Попробуйте позже."));
}

let activeTab: Tab = deepLinkMonth ? "report" : "home";

async function boot(): Promise<void> {
  const shell = el("div", { class: "app-shell" });
  const screenHost = el("div", { class: "screen-host" });
  shell.append(screenHost);
  mount(root!, shell);
  mount(screenHost, homeSkeleton());

  try {
    const state = await api.getOnboarding();
    if (!state.done) {
      renderOnboarding(screenHost, () => {
        void renderShell(shell, screenHost);
      });
      return;
    }
  } catch (e) {
    // 401 уже обработан глобально (configureApi перерисовал root целиком).
    if (sessionExpired) return;
    mount(
      screenHost,
      el("div", { class: "screen" }, [
        errorState(e instanceof Error ? e.message : "Не удалось запустить приложение", () => void boot()),
      ]),
    );
    return;
  }

  await renderShell(shell, screenHost);
}

async function renderShell(shell: HTMLElement, screenHost: HTMLElement): Promise<void> {
  shell.append(bottomNav(activeTab, (tab) => switchTab(screenHost, tab)));
  await renderScreen(screenHost);

  if (pendingAddDate !== undefined) {
    const date = pendingAddDate;
    pendingAddDate = undefined; // одноразово: перерисовка не должна открывать форму снова
    openNewTransactionSheet(() => void renderScreen(screenHost), date);
  }
}

async function renderScreen(screenHost: HTMLElement): Promise<void> {
  if (sessionExpired) return;
  if (activeTab === "home") {
    await renderHome(screenHost, {
      navigate: (tab) => switchTab(screenHost, tab),
      refreshChrome: () => {},
    });
  } else if (activeTab === "feed") {
    await renderFeed(screenHost, () => {});
  } else if (activeTab === "goals") {
    await renderGoals(screenHost, () => {});
  } else if (activeTab === "shops") {
    await renderShops(screenHost, () => {});
  } else if (activeTab === "report") {
    await renderReport(screenHost, deepLinkMonth);
  }
}

function switchTab(screenHost: HTMLElement, tab: Tab): void {
  activeTab = tab;
  const navHost = screenHost.parentElement?.querySelector(".bottom-nav");
  if (navHost) {
    const fresh = bottomNav(activeTab, (t) => switchTab(screenHost, t));
    navHost.replaceWith(fresh);
  }
  void renderScreen(screenHost);
}

void boot();
