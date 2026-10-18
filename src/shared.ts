import OBR from "@owlbear-rodeo/sdk";

export const NS = "hex-ranges.local";
export const METADATA_KEY = `${NS}/ranges`;
export const MODE_ID = `${NS}/mode`;
export const SETTINGS_ACTION_ID = `${NS}/settings-action`;
export const POPOVER_ID = `${NS}/popover`;
/** Wbudowane narzędzie Measure (tryb dopisujemy do jego paska). */
export const MEASURE_TOOL_ID = "rodeo.owlbear.tool/measure";

export const MAX_CELLS = 40;
/** Ograniczamy własny udział w limicie 16 KB metadanych pokoju. */
export const MAX_RANGES = 20;
export const MAX_RANGES_BYTES = 4096;

export interface RangeDef {
  id: string;
  name: string;
  /** Zasięg w komórkach (heksach). */
  cells: number;
  /** Kolor w formacie #rrggbb. */
  color: string;
  visible: boolean;
}

export const DEFAULT_RANGES: RangeDef[] = [
  { id: "move", name: "Ruch", cells: 6, color: "#3b82f6", visible: true },
  { id: "attack", name: "Atak", cells: 12, color: "#f59e0b", visible: true },
  { id: "spell", name: "Czar", cells: 20, color: "#a855f7", visible: true },
];

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Naprawia dane z metadanych (mogły zostać zmienione ręcznie lub przez starszą wersję). */
export function sanitizeRanges(value: unknown): RangeDef[] {
  if (!Array.isArray(value)) return DEFAULT_RANGES.map((r) => ({ ...r }));
  const out: RangeDef[] = [];
  for (const raw of value.slice(0, MAX_RANGES)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Partial<RangeDef>;
    const cells = Math.round(Number(r.cells));
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : newId(),
      name: typeof r.name === "string" ? r.name.slice(0, 30) : "Zasięg",
      cells: Number.isFinite(cells) ? Math.min(MAX_CELLS, Math.max(1, cells)) : 1,
      color: typeof r.color === "string" && /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : "#3b82f6",
      visible: r.visible !== false,
    });
  }
  return out;
}

export async function loadRanges(): Promise<RangeDef[]> {
  const metadata = await OBR.room.getMetadata();
  return sanitizeRanges(metadata[METADATA_KEY]);
}

export function validateRanges(ranges: RangeDef[]): void {
  if (ranges.length > MAX_RANGES) {
    throw new Error(`Maksymalnie ${MAX_RANGES} zasięgów.`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(ranges)).byteLength;
  if (bytes > MAX_RANGES_BYTES) {
    throw new Error(`Konfiguracja zajmuje ${bytes} B; limit rozszerzenia to ${MAX_RANGES_BYTES} B.`);
  }
}

export async function saveRanges(ranges: RangeDef[]): Promise<void> {
  const clean = sanitizeRanges(ranges);
  validateRanges(clean);
  await OBR.room.setMetadata({ [METADATA_KEY]: clean });
}

/** Subskrypcja zmian ustawień. Zwraca funkcję do anulowania. */
export function onRangesChange(callback: (ranges: RangeDef[]) => void): () => void {
  return OBR.room.onMetadataChange((metadata) => {
    callback(sanitizeRanges(metadata[METADATA_KEY]));
  });
}
