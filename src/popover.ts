import OBR from "@owlbear-rodeo/sdk";
import {
  DEFAULT_RANGES,
  loadRanges,
  MAX_CELLS,
  newId,
  onRangesChange,
  saveRanges,
  type RangeDef,
} from "./shared.ts";

const list = document.getElementById("list") as HTMLUListElement;
const addButton = document.getElementById("add") as HTMLButtonElement;
const resetButton = document.getElementById("reset") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLParagraphElement;

let ranges: RangeDef[] = [];
let saveTimer: number | undefined;
let statusTimer: number | undefined;

function setStatus(text: string, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
  window.clearTimeout(statusTimer);
  if (text && !isError) {
    statusTimer = window.setTimeout(() => (status.textContent = ""), 1800);
  }
}

/** Zapis z lekkim opóźnieniem, żeby nie wysyłać metadanych przy każdym ruchu suwaka koloru. */
function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    saveTimer = undefined;
    try {
      await saveRanges(ranges);
      setStatus("Zapisano");
    } catch (error) {
      console.error(error);
      setStatus("Nie udało się zapisać (brak uprawnień do ustawień pokoju?)", true);
    }
  }, 250);
}

function render() {
  list.replaceChildren();

  if (ranges.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Brak zasięgów. Dodaj pierwszy przyciskiem poniżej.";
    list.append(empty);
    return;
  }

  for (const range of ranges) {
    const row = document.createElement("li");

    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.checked = range.visible;
    visible.title = "Pokazuj ten zasięg";
    visible.setAttribute("aria-label", `Pokazuj zasięg ${range.name}`);
    visible.addEventListener("change", () => {
      range.visible = visible.checked;
      scheduleSave();
    });

    const color = document.createElement("input");
    color.type = "color";
    color.value = range.color;
    color.title = "Kolor zasięgu";
    color.setAttribute("aria-label", `Kolor zasięgu ${range.name}`);
    color.addEventListener("input", () => {
      range.color = color.value;
      scheduleSave();
    });

    const name = document.createElement("input");
    name.type = "text";
    name.value = range.name;
    name.maxLength = 30;
    name.setAttribute("aria-label", "Nazwa zasięgu");
    name.addEventListener("input", () => {
      range.name = name.value;
      scheduleSave();
    });

    const cells = document.createElement("input");
    cells.type = "number";
    cells.min = "1";
    cells.max = String(MAX_CELLS);
    cells.step = "1";
    cells.value = String(range.cells);
    cells.title = `Zasięg w heksach (1-${MAX_CELLS})`;
    cells.setAttribute("aria-label", `Liczba heksów zasięgu ${range.name}`);
    cells.addEventListener("input", () => {
      const value = Math.round(Number(cells.value));
      if (Number.isFinite(value) && value >= 1) {
        range.cells = Math.min(MAX_CELLS, value);
        scheduleSave();
      }
    });
    cells.addEventListener("change", () => {
      cells.value = String(range.cells);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "×";
    remove.title = "Usuń zasięg";
    remove.setAttribute("aria-label", `Usuń zasięg ${range.name}`);
    remove.addEventListener("click", () => {
      ranges = ranges.filter((r) => r.id !== range.id);
      render();
      scheduleSave();
    });

    row.append(visible, color, name, cells, remove);
    list.append(row);
  }
}

addButton.addEventListener("click", () => {
  ranges.push({ id: newId(), name: "Nowy zasięg", cells: 5, color: "#22c55e", visible: true });
  render();
  scheduleSave();
});

resetButton.addEventListener("click", () => {
  ranges = DEFAULT_RANGES.map((r) => ({ ...r }));
  render();
  scheduleSave();
});

function applyTheme(mode: string) {
  document.documentElement.dataset.theme = mode === "DARK" ? "dark" : "light";
}

OBR.onReady(async () => {
  applyTheme((await OBR.theme.getTheme()).mode);
  OBR.theme.onChange((theme) => applyTheme(theme.mode));

  ranges = await loadRanges();
  render();

  // Zmiana z innego miejsca (np. innego gracza). Nie nadpisujemy tego, co właśnie edytujemy.
  onRangesChange((next) => {
    if (saveTimer === undefined && !list.contains(document.activeElement)) {
      ranges = next;
      render();
    }
  });
});
