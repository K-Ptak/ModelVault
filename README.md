# ModelVault: menedżer biblioteki modeli 3D

## Instalacja
Pobierz z [Releases](https://github.com/K-Ptak/ModelVault/releases):
- **`ModelVault-Setup-x.y.z.exe`** – instalator: skrót w menu Start i na pulpicie, **automatyczne aktualizacje**,
- **`ModelVault-x.y.z-win-x64.zip`** – wersja przenośna: rozpakuj i uruchom `ModelVault.exe`, bez aktualizacji automatycznych.

Przy pierwszym starcie kreator przeprowadzi Cię przez konfigurację: folder z modelami, domyślny slicer,
drukarkę i cenę prądu, filamenty, stawkę za Twój czas i marżę (z przykładową wyceną na żywo), wygląd
oraz opcjonalne automatyzacje. Kreator uruchomisz ponownie w Ustawienia → O programie. Windows SmartScreen może ostrzec o nieznanym
wydawcy, bo aplikacja nie jest podpisana: „Więcej informacji” → „Uruchom mimo to”.

## Jak to działa
- **Biblioteka to zwykły folder.** Podfoldery są kategoriami. Aplikacja niczego nie kopiuje
  ani nie przerabia, tylko pokazuje to, co jest na dysku.
- **Przenoszenie działa w obie strony.** Przeciągnięcie modelu na folder po lewej przenosi
  plik na dysku. Zmiany zrobione w Eksploratorze aplikacja wykrywa sama.
- **Tagi, status (do wydruku / wydrukowane), ulubione i notatki** są zapisywane w pliku
  `.modelvault.json` w głównym folderze biblioteki, więc wędrują razem z nim (pendrive, OneDrive, NAS).
  Jeśli przeniesiesz plik w Eksploratorze, tagi go „znajdą” po nazwie i rozmiarze.
- **Miniatury:** obrazek o tej samej nazwie co model (np. `smok.stl` + `smok.png`) ma pierwszeństwo.
  Potem miniatura osadzona w 3MF / G-code (Prusa, Bambu, Orca). W ostatniej kolejności aplikacja
  renderuje model sama. Miniatury trafiają do cache w `%APPDATA%\ModelVault`.
- **Podgląd 3D:** STL, 3MF, OBJ, PLY, G-code (ścieżki druku). Wymiary, objętość,
  szacowana waga w PLA przy 100% wypełnienia (górna granica, przydatna do wyceny).
- Inne pliki (STEP, SCAD, F3D, BLEND…) są na liście, ale bez podglądu 3D.

## Wycena wydruków
Logika jest taka sama jak w arkuszu wyceny: filament (cena/kg), prąd (moc × czas + energia
na start każdego wydruku), eksploatacja drukarki (cena / żywotność + serwis), Twój czas
(na każdy wydruk + na całe zamówienie), bufor na nieudane wydruki, opcjonalnie marża
i zaokrąglenie ceny dla klienta.

- **Skąd brane są gramy i czas:**
  1. wartości wpisane ręcznie,
  2. dane ze slicera: komentarze w G-code (PrusaSlicer, OrcaSlicer, Bambu Studio, Cura)
     albo `slice_info.config` w pociętym 3MF (Bambu / Orca),
  3. szacunek z objętości modelu (oznaczony „~”, parametry w ustawieniach).
- **Wycena modelu** jest w panelu po prawej. **Wycena zamówienia** to osobny widok
  (pozycja „Wycena zamówienia” po lewej): modele z biblioteki plus pozycje ręczne, liczba
  wydruków, zestawienie materiałów, rozbicie kosztów, kopiowanie podsumowania do schowka
  i eksport CSV (Excel).
- **Biblioteka filamentów** jest w ustawieniach: nazwa, kolor, typ, cena za kg, gęstość
  i kolor do podglądu 3D. Jeden filament jest domyślny.
- Ustawienia aplikacji, filamenty i bieżąca wycena są zapisane w `%APPDATA%\ModelVault\settings.json`.
  Gramy, czas i filament przypisany do modelu trafiają do `.modelvault.json` w bibliotece.

## Wydruki wielokolorowe
Aplikacja odczytuje, która część modelu ma który kolor:
- **3MF z Bambu Studio / OrcaSlicer:** filament przypisany do obiektów i części
  (`model_settings.config`), malowanie kolorów po powierzchni (`paint_color`) oraz kolory
  filamentów z projektu. Po pocięciu odczytuje gramy **osobno dla każdego filamentu**, z purge i wieżą.
- **3MF z PrusaSlicer:** ekstruder przypisany do obiektów i części, malowanie MMU
  (`mmu_segmentation`), kolory ekstruderów.
- **Standardowe materiały 3MF** (basematerials / colorgroup), np. z Fusion 360.
- **G-code:** ścieżki rysowane osobno dla każdego narzędzia (T0, T1…), kolory z nagłówka,
  gramy per filament i liczba zmian koloru policzona z pliku.
- **OBJ** z kilkoma materiałami (`usemtl`).

Podgląd 3D pokazuje każdy kolor osobno. W panelu wyceny każdemu kolorowi przypisujesz szpulę;
aplikacja sama podpowiada szpulę o najbliższym kolorze („Auto”). Gdy nie ma danych ze slicera,
zmiany koloru są szacowane z wysokości kolorów (k kolorów w warstwie = k−1 zmian), a do wyceny
doliczany jest purge (g na zmianę) i czas zmian. Parametry są w Ustawienia → Wycena.

## Magazyn filamentów
Stan każdej szpuli w gramach, wartość filamentu na stanie i ostrzeżenia o kończących się szpulach.
Ostrzeżenia pojawiają się też w wycenie, jeśli filamentu zabraknie. Filament jest odejmowany
po oznaczeniu modelu jako „Wydrukowane” albo przy zmianie statusu zamówienia (do wyboru).
Każde odjęcie można cofnąć z historii zużycia.

## Zamówienia
„Zapisz jako zamówienie” w wycenie tworzy zamówienie z numerem (np. 2026/001). Ma statusy
Wycenione → W druku → Wydane / Anulowane, cenę uzgodnioną z klientem i notatkę.
Podsumowanie miesiąca pokazuje przychód, koszt własny, zysk, zużyty filament i czas druku.
Zamówienie można wczytać z powrotem do wyceny.

## Duplikaty i źródła
- **Duplikaty:** pliki o identycznej zawartości (porównanie sumą SHA-1), pogrupowane, z informacją,
  ile miejsca można odzyskać.
- **Źródło:** link do Printables / MakerWorld / Thingiverse przy modelu, otwierany jednym kliknięciem.
  Jeśli w notatce jest link, aplikacja go podpowie.

## Wiele płyt w jednym pliku
Eksporty z Bambu Studio / MakerWorld często mają kilka płyt w jednym STL (płyty leżą obok siebie
co 1,2 × szerokość stołu). Aplikacja wykrywa płyty, pokazuje wymiary każdej z nich, pozwala obejrzeć
pojedynczą płytę w podglądzie i liczy każdą płytę jako osobny wydruk (start drukarki + czas obsługi).
W 3MF z Bambu Studio płyty są odczytywane wprost z pliku.

## Slicery
Aplikacja wykrywa zainstalowane slicery (Bambu Studio, OrcaSlicer, PrusaSlicer, UltiMaker Cura,
Creality Print, ElegooSlicer, Anycubic Slicer Next, SuperSlicer, FlashPrint). Możesz też dodać własny,
wskazując plik .exe. W Ustawienia → Slicery wybierasz domyślny slicer, który otwiera się po dwukliku,
klawiszem Enter i przyciskiem „Otwórz”. Ukrywasz tam też te, których nie chcesz widzieć.
Niezainstalowane slicery nie pojawiają się w menu.

## Pobrane → „Do posortowania”
Po włączeniu w Ustawienia → Pobrane aplikacja śledzi wybrane foldery (domyślnie Pobrane). Nowe pliki
modeli przenosi lub kopiuje do folderu biblioteki „Do posortowania”. Archiwa ZIP z modelami
(np. z Printables) rozpakowuje do osobnego folderu. Stamtąd przeciągasz modele do kategorii.

## Miniatury
- domyślny kąt kamery dla wszystkich miniatur (Ustawienia → Wygląd),
- własny kąt dla modelu: obróć podgląd i kliknij ◉ (zapisywane w `.modelvault.json`),
- własne zdjęcie, np. gotowego wydruku: kopiowane obok modelu jako `nazwa_modelu.jpg/png`.

## Kolekcje
Wirtualne grupy modeli, np. „Prezenty na święta” albo „Do sklepu”. Pliki się nie przenoszą,
a jeden model może być w wielu kolekcjach. Modele dodajesz, przeciągając je na kolekcję
albo przez menu pod prawym przyciskiem.

## Klienci i oferty
Baza klientów z liczbą zamówień, przychodem i zyskiem. Klienta wybierasz w wycenie.
„Oferta PDF” generuje ofertę z miniaturami, materiałami, ilościami i cenami. Dane firmy
ustawiasz w Ustawienia → Oferta.

## Kolejka druku i statystyki
- **Kolejka:** zamówienia „W druku” w ustalonej kolejności, z przewidywanym startem i końcem.
  Uwzględnia liczbę drukarek i godziny pracy. Wykres Gantta pokazuje terminy i ostrzega przed spóźnieniem.
- **Statystyki** (w widoku Zamówienia): przychód, koszt i zysk z 12 miesięcy, zysk według kategorii
  (folderów) i zużycie filamentów.

## Kopie zapasowe
Codzienna automatyczna kopia ustawień, filamentów, magazynu, klientów, zamówień oraz tagów i notatek
biblioteki (14 ostatnich). Do tego ręczny eksport i import do pliku. Przed przywróceniem kopii
aplikacja zawsze robi kopię bieżącego stanu.

## Ustawienia (Ctrl+,)
- **Wygląd:** kolor modelu w podglądzie i na miniaturach, opcja użycia koloru przypisanego filamentu.
- **Wycena:** wszystkie parametry kosztów, domyślny filament, waluta.
- **Filamenty:** biblioteka filamentów.

## Skróty
| Skrót | Akcja |
|---|---|
| klik / Ctrl+klik / Shift+klik | zaznacz / dodaj do zaznaczenia / zakres |
| strzałki | poruszanie po siatce |
| dwuklik / Enter | otwórz w domyślnym programie (slicerze) |
| F2 | zmień nazwę |
| Del | do Kosza |
| F | ulubione |
| Ctrl+F | szukaj (nazwa, ścieżka, tagi, notatki) |
| Ctrl+A | zaznacz wszystko |
| Ctrl+, | ustawienia |
| prawy przycisk | menu kontekstowe (pliki i foldery) |

Pliki przeciągnięte z Eksploratora do okna są **kopiowane** do bieżącego folderu.

## Rozwój
Electron + three.js.
```
npm install      # instaluje zależności i kopiuje potrzebne pliki three.js do renderer/vendor
npm start        # uruchamia aplikację
npm test         # testy logiki (wycena, kolory, płyty); MV_REAL_DIR=… dodaje testy na prawdziwych plikach
npm run dist     # buduje instalator i ZIP lokalnie (Windows)
```

### Wydanie nowej wersji
1. Zmień `version` w `package.json` (np. `1.3.1`) i zrób commit.
2. `git tag v1.3.1 && git push origin main v1.3.1`
3. GitHub Actions uruchomi testy, zbuduje instalator i ZIP na Windows i opublikuje Release.
   Zainstalowane aplikacje same zaproponują aktualizację.
