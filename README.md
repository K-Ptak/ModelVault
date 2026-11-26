# ModelVault: menedżer biblioteki modeli 3D

## Uruchomienie
Rozpakuj `ModelVault-win-x64.zip` gdziekolwiek (np. `C:\Programy\ModelVault`) i odpal `ModelVault.exe`.
Bez instalacji. Przy pierwszym starcie wskaż folder z modelami.
(Windows SmartScreen może ostrzec o nieznanym wydawcy: „Więcej informacji” → „Uruchom mimo to”.)

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

## Kod źródłowy
Electron + three.js. Z folderu źródeł:
```
npm install
npm start
```
