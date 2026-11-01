# SeaDoc

MVP pentru management electronic al documentelor, construit pentru demonstrația din licitația CTP Iași SCN1180726. Specificația este în [documentul SeaDoc](https://claude.ai/artifact/FLEFudFUcrL2UtywD9tQkc), iar contractul API în [docs/API.md](docs/API.md).

## Pornire

Cere Node.js 24 și pachetul PostgreSQL 16 (doar binarele și extensiile `unaccent`, `pg_trgm`). Serverul de baze de date al sistemului nu este folosit: proiectul pornește propriul cluster în `.data/pg`, pe `127.0.0.1:55432`.

```bash
npm install
npm run db:start     # creează la prima rulare clusterul și .env, cu chei generate
npm run build
npm run seed         # doar prima dată; date demonstrative
npm start            # http://127.0.0.1:4100
```

La oprire: `Ctrl+C`, apoi `npm run db:stop`. Pentru a reface datele demo: `node apps/api/dist/scripts/seed.js --reset` (generează o parolă nouă).

Conturile și parola demo sunt în `.data/demo-credentials.txt`. `admin.demo` are MFA activ: adăugați secretul din acel fișier într-o aplicație de autentificare. Fișierul `.env` conține cheia de criptare a fișierelor; fără ea, fișierele stocate nu mai pot fi citite.

## Teste

```bash
npm run build -w apps/api
cd apps/api
DATABASE_URL=postgres://seadoc@127.0.0.1:55432/seadoc_test node --test --test-force-exit dist/test/api.test.js
DATABASE_URL=postgres://seadoc@127.0.0.1:55432/seadoc_wf_test node --test --test-force-exit dist/test/workflow.test.js
DATABASE_URL=postgres://seadoc@127.0.0.1:55432/seadoc_mail_test node --test --test-force-exit dist/test/mail.test.js
DATABASE_URL=postgres://seadoc@127.0.0.1:55432/seadoc_intg_test node --test --test-force-exit dist/test/integrations.test.js
```

Semnăturile, previzualizarea și TIFF (agentul pornește ca proces separat; baza se creează o dată, cu `createdb seadoc_sign_test`):

```bash
DATABASE_URL=postgres://seadoc@127.0.0.1:55432/seadoc_sign_test node --test --test-force-exit dist/test/sign.test.js
```

Testele rulează pe PostgreSQL real și șterg datele din bazele de test. Bazele `seadoc_wf_test`, `seadoc_mail_test` și `seadoc_intg_test` se creează o singură dată, cu `createdb`.

## Migrarea arhivei

Patru pași, reluabili oricând. Căile relative se citesc față de dosarul din care lansați comanda. Rulați întâi `npm run build`; pornirea serverului actualizat aplică migrarea bazei de date.

```bash
# 1. Inventar: fișiere, tipuri, dimensiuni, SHA-256. Nu atinge baza de date. Linkurile simbolice nu se urmează.
npm run migrate:archive -w apps/api -- inventory /cale/arhiva --manifest export.csv --out inventar.csv
# 2. Mapare: verifică regulile pe inventar, fără să importe nimic.
npm run migrate:archive -w apps/api -- map mapare.yaml --inventory inventar.csv
# 3. Import: --dry-run nu scrie documente; --commit scrie. O nouă rulare sare peste ce s-a importat deja.
npm run migrate:archive -w apps/api -- import --inventory inventar.csv --mapping mapare.yaml --root /cale/arhiva --dry-run
npm run migrate:archive -w apps/api -- import --inventory inventar.csv --mapping mapare.yaml --root /cale/arhiva --commit
# 4. Raport: recalculează hash-urile din stocare și scrie CSV și PDF de semnat. Ieșire 2 la orice nepotrivire.
npm run migrate:archive -w apps/api -- report 7 --out rapoarte --recount
```

Comenzile folosesc baza de date și cheia din `.env`. Importul afișează baza pe care scrie.

Fișierul de mapare (YAML sau JSON): prima regulă potrivită se aplică. Câmpurile `{nume}` vin din grupurile expresiei `pattern`, din coloanele manifestului sau din `path`, `filename`, `stem`, `ext`, `folder`, `parent`, `top`, `mtime`.

```yaml
source: arhiva-registratura-2019   # identifică fișierele la o nouă rulare
defaults:
  department: Registratură
rules:
  - match: { folder: "sistem/**" }
    skip: true
  - match:
      pattern: '^contracte/(?<an>\d{4})/(?<numar>\d+)_(?<titlu>.+)\.pdf$'
    set:
      documentType: Contract       # denumirea din aplicație
      register: RC                 # codul sau denumirea registrului
      regNumber: "{numar}"
      regYear: "{an}"
      regDate: "{data}"            # din manifest; AAAA-LL-ZZ sau ZZ.LL.AAAA
      regLabel: "{numar}/{an}"     # opțional; implicit RC-00012/2019
      title: "{titlu}"
      direction: intrat
      metadata: { partener: "{emitent}" }
```

Tipurile, registrele și departamentele trebuie să existe; maparea nu le creează. Numerele istorice se păstrează, o coliziune se raportează fără renumerotare, iar contorul registrului avansează peste cel mai mare număr importat. Documentele aparțin contului tehnic inactiv `migrare.sistem`, iar OCR rulează în serverul pornit, prin coada obișnuită. Rulările și rapoartele se văd în Administrare, la Migrare.

## Scenariul de demo

Ghidul complet, cu capturi pentru fiecare pagină și textul de prezentare, este în [docs/demo](docs/demo/README.md).

| Pas | Ce se arată | Cont |
| --- | --- | --- |
| 2 | Autentificare cu MFA | `admin.demo` |
| 3 | Înregistrarea `samples/scan-instructiune-ssm.pdf`: număr, OCR, PDF căutabil | `registratura.demo` |
| 4 | Pornirea fluxului „Instruire SSM” | `registratura.demo` |
| 5 | Avizare de pe telefon, apoi semnătură internă pe desktop | `ion.popescu`, `maria.ionescu`, `director.general` |
| 6 | Diagrama fluxului cu statusul pașilor | oricare cont cu acces |
| 7 | Modificarea fluxului în editor și publicarea unei versiuni noi | `manager.ssm` |
| 8 | Arhivare după tip și termen de păstrare | `arhivar.demo` |
| 9 | Căutare fără diacritice, favorite, duplicat cu `samples/duplicat-procedura.pdf` | `admin.demo` |
| 10 | Aceeași listă din conturile de administrator, manager și utilizator | `admin.demo`, `manager.ssm`, `maria.ionescu` |
| 11 | Audit filtrat pe document, export CSV, verificarea lanțului | `admin.demo` |
| 12 | Criptare, retenție, jurnalul accesului la date personale | `admin.demo` |

## Diferențe față de specificație

MVP-ul rulează pe Node.js și PostgreSQL, fără Docker sau Java. Stiva din specificație se înlocuiește astfel:

| Componentă în specificație | În MVP | Observații |
| --- | --- | --- |
| Flowable | Motor propriu în `workflow-engine.ts` | Execută BPMN 2.0: start, final, sarcină utilizator, porți paralele și exclusive |
| OpenSearch | Căutare full-text PostgreSQL | Dicționar românesc, fără diacritice și cu forme vechi cu sedilă |
| Keycloak | Parole, blocare și TOTP în aplicație, plus LDAP/AD și OIDC opționale | Un Keycloak, ADFS sau Entra ID se poate conecta prin OIDC |
| OCRmyPDF + Tesseract | tesseract.js, pdf.js, pdf-lib | Același motor Tesseract, cu datele pentru română |
| MinIO | Disc, cu criptare AES-256-GCM | Alternativa prevăzută în specificație |
| Docker Compose | Procese locale | Nu există încă imagini Docker |

## Ce nu este construit

- **Semnătura calificată eIDAS, dovedită.** Există semnătura internă (parolă, amprentă SHA-256, sigiliu HMAC) și semnătura cu certificat în PDF, prin agentul local din `apps/agent`. Cea cu certificat a fost încercată doar cu certificate de test generate în teste, dintr-un fișier PKCS#12. Driverul pentru token (PKCS#11) nu a rulat niciodată, interfața nu a fost încercată într-un browser real, iar rezultatul nu a fost deschis în Adobe Acrobat. Nu are marcă temporală (PAdES B-B, fără B-T sau LTV), semnătura este invizibilă și nu se folosește EU DSS. Agentul cere SeaDoc pe HTTPS în Chrome; vezi [apps/agent/README.md](apps/agent/README.md).
- **Verificarea semnăturilor primite, completă.** PDF-urile se verifică la cerere: amprentă, semnătură CMS, acoperirea fișierului, valabilitatea certificatului și lanțul până la rădăcinile din `TRUST_ROOTS_DIR`. Nu se verifică revocarea (OCSP/CRL), statutul calificat (lista de încredere UE) și mărcile temporale, iar aplicația spune asta în rezultat. Dacă fișierul are octeți după semnătură, se semnalează, fără analiza a ceea ce s-a schimbat.
- **AD și SSO în producție.** LDAP/AD și OIDC funcționează după configurare (vezi `.env.example`), dar au fost testate pe un server `ldapjs` cu intrări ca în AD și pe un emitent OIDC de test, nu pe un AD sau un furnizor real. Grupurile imbricate nu se rezolvă, iar ieșirea din aplicație nu închide și sesiunea de la furnizor.
- **Nexus ERP.** Nu există nicio conexiune cu Nexus: dacă are un API și în ce format exportă sunt întrebări încă deschise. Există doar importul din CSV al partenerilor, facturilor și comenzilor, și legarea lor de documente. Fișierele Excel se salvează întâi ca CSV.
- **Migrarea arhivei, pe date reale.** Instrumentul a fost rulat doar pe arbori de test. Documentele importate rămân în starea `inregistrat`, deci termenul de păstrare se stabilește la arhivarea ulterioară. Scanările TIFF se importă fără OCR.
- **Email în producție.** Trimiterea și preluarea din email funcționează, dar sunt activate doar după configurarea SMTP și IMAP (vezi `.env.example`). Au fost testate pe servere de test (`smtp-server`, `hoodiecrow-imap`), nu pe un server de email real. Autentificarea este cu utilizator și parolă, fără OAuth2, pe care Microsoft 365 și Gmail îl pot cere.
- **GDPR.** Cererile persoanelor vizate se înregistrează, cu termen, căutare, export și decizie, dar ștergerea sau rectificarea nu se execută automat. Exportul conține lista documentelor și jurnalul de acces, nu și fișierele. Nu există alertă automată la apropierea termenului și nici prelungirea lui.
- **Previzualizare Office, completă.** DOCX și XLSX se văd în browser fără aspectul original (fără stiluri), iar XLSX cel mult 30 de foi, 2000 de rânduri și 100 de coloane. Din PPTX se vede doar textul fiecărui diapozitiv. Formatele binare vechi (`.doc`, `.xls`, `.ppt`) se stochează, fără previzualizare și fără text extras, și se descarcă.
- **HTTPS și programarea automată.** HTTPS cere un domeniu cu certificat, iar pornirea la restart și backup-ul zilnic cer intrările de cron din [docs/DEPLOY.md](docs/DEPLOY.md). Backup-ul și restaurarea există și au fost testate, dar copia stă pe același disc până când se configurează o altă locație. Baza de date, unde stă textul extras, nu este criptată; pentru asta e nevoie de criptarea discului.
- **Docker Compose, rulat.** Fișierele există, dar nu au fost rulate: serverul de dezvoltare nu are Docker.
- **Performanță în producție.** Măsurat pe acest server (2 CPU, 4 GB), cu 20 de utilizatori simultani, 60 s și 20.000 de documente, cu clientul pe același server: căutare p50 97 ms, p95 381 ms, maximum 1,9 s; deschidere document p50 37 ms, p95 235 ms; înregistrare p50 43 ms, p95 206 ms; fără erori. Măsurarea nu include OCR pe scanări mari, și nici rețeaua reală sau volumul real al CTP.
- **Disponibilitate.** Cele 99,5% lunar nu au fost măsurate, iar pe un singur server nu există redundanță.
