import OBR from "@owlbear-rodeo/sdk";
import {
  DEFAULT_RANGES,
  loadRanges,
  MAX_CELLS,
  MAX_RANGES,
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
let lastSynced = "";
let saving = false;
let inFlightSnapshot: string | null = null;
let conflict = false;
let revision = 0;
const snapshot = (value: RangeDef[]) => JSON.stringify(value);


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
  if (conflict) {
    setStatus("Inny gracz zmienił ustawienia. Zamknij i otwórz panel ponownie, aby wczytać aktualne dane.", true);
    return;
  }
  revision++;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void commitChanges();
  }, 250);
}

async function commitChanges() {
  if (saving || conflict) return;
  saving = true;
  const savingRevision = revision;
  const payload = ranges.map((r) => ({ ...r }));
  try {
    // Kontrola konfliktu typu optimistic concurrency. SDK nie ma atomowego compare-and-swap,
    // więc wyścigu między tym odczytem i zapisem nie można wyeliminować w 100%.
    const remote = await loadRanges();
    if (snapshot(remote) !== lastSynced) {
      conflict = true;
      setStatus("Wykryto zmianę ustawień u innego gracza. Otwórz panel ponownie; niczego nie nadpisano.", true);
      return;
    }
    inFlightSnapshot = snapshot(payload);
    await saveRanges(payload);
    lastSynced = inFlightSnapshot;
    setStatus("Zapisano");
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : "Nie udało się zapisać ustawień.", true);
  } finally {
    inFlightSnapshot = null;
    saving = false;
    if (!conflict && revision !== savingRevision) {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = undefined;
        void commitChanges();
      }, 250);
    }
  }
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

    row.append(color, name, cells, remove);
    list.append(row);
  }
}

addButton.addEventListener("click", () => {
  if (ranges.length >= MAX_RANGES) {
    setStatus(`Maksymalnie ${MAX_RANGES} zasięgów.`, true);
    return;
  }
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
  lastSynced = snapshot(ranges);
  render();

  // Zmiana z innego miejsca (np. innego gracza). Nie nadpisujemy tego, co właśnie edytujemy.
  onRangesChange((next) => {
    const incoming = snapshot(next);
    if (incoming === lastSynced || incoming === inFlightSnapshot) return;
    if (saveTimer !== undefined || saving || snapshot(ranges) !== lastSynced) {
      // Nie akceptujemy obcych zmian jako podstawy dla lokalnego zapisu.
      // Może to być również echo poprzedniego zapisu; ponowny odczyt przy zapisie
      // rozstrzygnie aktualny stan.
      window.clearTimeout(saveTimer);
      saveTimer = undefined;
      conflict = true;
      setStatus("Ustawienia zmieniły się w innym oknie. Zamknij i otwórz panel ponownie.", true);
      return;
    }
    if (!list.contains(document.activeElement)) {
      ranges = next;
      lastSynced = incoming;
      render();
    }
  });
});
