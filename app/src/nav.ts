import { el } from "./dom.js";
import { iconHome, iconFeed, iconGoals, iconReport } from "./icons.js";

export type Tab = "home" | "feed" | "goals" | "report";

const TABS: { id: Tab; label: string; icon: () => SVGSVGElement }[] = [
  { id: "home", label: "Главная", icon: iconHome },
  { id: "feed", label: "Лента", icon: iconFeed },
  { id: "goals", label: "Цели", icon: iconGoals },
  { id: "report", label: "Отчёт", icon: iconReport },
];

export function bottomNav(active: Tab, onSelect: (tab: Tab) => void): HTMLElement {
  return el(
    "nav",
    { class: "bottom-nav", role: "tablist", "aria-label": "Разделы приложения" },
    TABS.map((t) =>
      el(
        "button",
        {
          class: `nav-btn${t.id === active ? " nav-btn-active" : ""}`,
          type: "button",
          role: "tab",
          "aria-selected": t.id === active,
          onclick: () => onSelect(t.id),
        },
        [el("span", { class: "nav-icon" }, [t.icon()]), el("span", { class: "nav-label", text: t.label })],
      ),
    ),
  );
}
