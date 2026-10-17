# Hex Ranges

Rozszerzenie do Owlbear Rodeo: podczas przeciągania tokenu pokazuje zasięgi (ruch, atak, czary…) na siatce heksagonalnej.
Każdy zasięg ma własną nazwę, liczbę heksów i kolor, a listę można dowolnie edytować.

## Użycie

1. Na pasku narzędzi wybierz **Measure**, a w jego menu tryb **Zasięgi hex** (obok Ruler, Movement itd.).
2. Przeciągnij token. Rusza się od razu za myszką (z przyciąganiem do siatki), a zasięgi zostają w miejscu startu.
   Linia pokazuje drogę, a etykieta liczbę heksów od punktu startu.
3. Przeciągnięcie z pustego miejsca na mapie robi to samo bez przesuwania czegokolwiek (sam pomiar).
4. Gdy aktywne jest narzędzie **Measure**, na pasku jest przycisk **Ustawienia zasięgów** (suwaki).
   Tam zmieniasz nazwy, liczby heksów, kolory, widoczność oraz dodajesz i usuwasz zasięgi.

Każdy zasięg jest osobnym pierścieniem (komórki między poprzednim a tym zasięgiem), więc kolory się nie nakładają ani nie mieszają.
Kolorowe zasięgi widzisz tylko Ty; linię pomiaru i liczbę heksów widzą też inni gracze, tak jak ruch tokenu. Działa tylko na scenach z siatką **Hex**; ustawienia zapisują się w metadanych pokoju.

Przeciągane są tokeny z warstw Character, Mount i Prop, które nie są zablokowane. Przesuwany jest jeden token naraz.

## Uruchomienie lokalne

```bash
npm install
npm test          # testy geometrii heksów
npm run build     # sprawdzenie typów + build
npm run dev       # serwer na http://localhost:5173
```

W Owlbear Rodeo: **Profil → Add Extension** i wklej `http://localhost:5173/ColorHexes/manifest.json`.

## Wdrożenie na GitHub Pages

Repozytorium zawiera workflow `.github/workflows/deploy.yml`, który po każdym pushu na `main` buduje projekt i publikuje go.

1. W repozytorium: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Wypchnij zmiany na `main` (albo uruchom workflow ręcznie w zakładce **Actions**).
3. Po zakończeniu workflow adres manifestu to:
   `https://<twoja-nazwa-użytkownika>.github.io/ColorHexes/manifest.json`

Jeśli zmienisz nazwę repozytorium, zmień też `base` w `vite.config.ts` oraz ścieżki w `public/manifest.json`.
Po aktualizacji rozszerzenia usuń je w Owlbear i dodaj ponownie (albo odśwież stronę), żeby pobrało nowy manifest.

## Struktura

| Plik | Rola |
| --- | --- |
| `public/manifest.json` | Manifest rozszerzenia (tylko strona w tle) |
| `src/background.ts` | Tryb w Measure, akcja ustawień, przesuwanie tokenu, rysowanie zasięgów |
| `src/popover.ts`, `popover.html`, `src/popover.css` | Okno ustawień |
| `src/shared.ts` | Typy, wartości domyślne, zapis ustawień w metadanych pokoju |
| `src/hex.ts` | Czysta geometria heksów (bez SDK) |
| `test/hex.test.ts` | Testy geometrii |
