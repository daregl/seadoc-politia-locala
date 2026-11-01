# Agentul local SeaDoc

Program pentru calculatorul celui care semnează. Rulează fără drepturi de administrator, ascultă doar pe `127.0.0.1` și semnează amprente SHA-256 cu un certificat din fișier PKCS#12 sau de pe un token PKCS#11. Rezultatul este un CMS detașat, în stil PAdES (`signing-certificate-v2`, fără `signing-time`).

PIN-ul sau parola se introduc într-o pagină servită de agent și nu ajung la aplicația web. Aplicația primește doar semnătura.

## Instalare

Cere Node.js 20 sau mai nou.

```bash
cd apps/agent
npm install --omit=dev
node src/cli.js origin add https://seadoc.exemplu.ro   # adresa la care se deschide SeaDoc
node src/cli.js import-p12 certificat.p12              # sau: node src/cli.js pkcs11 /cale/modul.so
node src/cli.js pair                                   # tokenul de asociere, de copiat în SeaDoc
node src/cli.js start                                  # implicit pe http://127.0.0.1:47800
```

Configurația stă în `~/.seadoc-agent/config.json` (altă cale: `SEADOC_AGENT_HOME`), cu permisiuni doar pentru utilizator. Conține originile permise, tokenul de asociere, certificatele publice și calea către fișierul PKCS#12, nu chei sau parole. Portul se schimbă cu `SEADOC_AGENT_PORT`; atunci și serverul SeaDoc trebuie să aibă `SIGN_AGENT_ORIGIN` corespunzător, fiindcă altfel politica CSP a paginii blochează apelul.

## Ce oprește o pagină web oarecare

| Măsură | Ce face |
| --- | --- |
| Adresă | Serverul se leagă doar de `127.0.0.1`; nu există opțiune pentru altă adresă |
| Antet `Host` | Doar `127.0.0.1:port` și `localhost:port`; oprește DNS rebinding |
| `Origin` | Doar originile adăugate cu `origin add`; celelalte primesc 403 fără antete CORS |
| Token de asociere | Antetul `X-SeaDoc-Agent-Token`, obligatoriu în afară de `/health`. Regenerare: `pair --new` |
| Confirmare | Fiecare semnătură se confirmă în pagina agentului, cu PIN. Formularul cere `Origin` egal cu al agentului și un token pe care aplicația web nu îl poate citi |

## Interfață

Toate cererile cer o origine permisă; în afară de `/health` cer și tokenul.

- `GET /health` → `{agent, version, paired}`
- `GET /certificates` → `{certificates:[{id,driver,subject,issuer,serial,sha256,validFrom,validTo,expired,testCertificate,certPem}], problems:[]}`
- `POST /sign {certificateId, digestAlgorithm:"SHA-256", digestHex, label?}` → 202 `{requestId, confirmUrl, expiresAt}`. Cererea expiră în 2 minute.
- `GET /sign/:requestId` → `{status: asteapta|semnat|refuzat|expirat|esuat, message, cms}`; `cms` este base64.
- `GET`, `POST /confirm/:requestId?t=…`: pagina pe care o deschide utilizatorul.

Agentul semnează o amprentă și nu poate verifica ce document îi corespunde. Descrierea documentului din pagina de confirmare vine de la aplicația web și este afișată ca atare. Serverul SeaDoc verifică la finalizare că semnătura este peste PDF-ul pregătit de el.

## Chrome și apelurile către agent

Stare citită în noiembrie 2026, din documentație. Pe mașina de dezvoltare nu există browser, deci nimic din această secțiune nu a fost observat în Chrome.

- **HTTPS este obligatoriu pentru SeaDoc.** Chrome tratează orice cerere de la un site public sau din rețeaua locală către `127.0.0.1` ca [Local Network Access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access): cere permisiunea `loopback-network` (din Chrome 145, cu vechea `local-network-access` ca alias), iar în paginile `http://` o refuză automat. Asta include un SeaDoc de intranet servit prin `http://10.x.x.x`. Excepție: pagina servită chiar de pe `127.0.0.1`.
- **Utilizatorul vede o cerere de permisiune** la prima căutare a agentului. Dacă o refuză, pentru SeaDoc agentul pare absent, până când schimbă permisiunea site-ului.
- **Agentul rămâne pe HTTP.** `http://127.0.0.1` nu se blochează ca „mixed content” dintr-o pagină HTTPS: [specificația](https://wicg.github.io/local-network-access/) îl consideră deja de încredere. Aplicația trimite și `targetAddressSpace: 'loopback'`, ca în ghidul Chrome, și repetă cererea fără opțiune dacă browserul nu o cunoaște. Adresa trebuie să fie IP-ul `127.0.0.1`, nu un nume de domeniu.
- **Private Network Access** (preflight cu `Access-Control-Request-Private-Network`) a fost [înlocuit de permisiunea de mai sus](https://developer.chrome.com/blog/local-network-access). Agentul răspunde în continuare cu `Access-Control-Allow-Private-Network: true`, pentru browserele mai vechi.
- **Iframe.** Dacă SeaDoc ajunge vreodată într-un cadru, cadrul are nevoie de `allow="loopback-network"`.
- **Calculatoare administrate.** Politicile `LoopbackNetworkAllowedForUrls` și `LocalNetworkAccessAllowedForUrls` pot acorda permisiunea dinainte. Le-am găsit în [documentația Edge](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/loopbacknetworkblockedforurls) și la Samsung, nu pe o pagină Google; verificați numele în lista de politici Chrome înainte de implementare.
- **Serverul SeaDoc** adaugă originea agentului în `connect-src` (variabila `SIGN_AGENT_ORIGIN`). Fără ea, politica CSP blochează apelul înainte de orice altă regulă.

Firefox și Safari nu au fost verificate.

## Ce a fost testat și ce nu

**Testat în `apps/api/test/sign.test.ts`**, prin procesul real al agentului și HTTP real: PKCS#12 cu certificate de test RSA generate în test, respingerea originii, tokenului și gazdei false, preflight, confirmarea, parola greșită, refuzul. CMS-ul rezultat este verificat independent cu `openssl cms -verify`.

**Ce nu a fost testat:**

- **Driverul PKCS#11 (`src/drivers/pkcs11.js`) nu a rulat niciodată.** Pe mașina de dezvoltare nu există token, nici compilator pentru `pkcs11js`. Codul urmează tipurile din `pkcs11js` 2.1.7, atât. Așteptați-vă la ajustări pentru modulul furnizorului: cum își expune certificatele, ce se vede înainte de autentificare, mecanismele acceptate. Testați întâi cu un certificat de test al furnizorului, ca să nu blocați tokenul cu PIN-uri greșite.
- **Niciun certificat calificat real.** Nu s-a încercat vreo semnătură cu certificat emis de un furnizor acreditat și nici deschiderea rezultatului în Adobe Acrobat. Acrobat poate avea cerințe pe care verificările de aici nu le acoperă.
- **Interfața web într-un browser real.** Pe această mașină nu există niciun browser. Apelurile HTTP ale agentului sunt testate cu `fetch` din Node, care nu aplică CORS, CSP sau Local Network Access; pagina de confirmare și dialogul din SeaDoc nu au fost deschise. Regulile Chrome de mai sus sunt citite din documentație, nu observate.
- **Fișierele PKCS#12 cu chei EC.** Biblioteca `node-forge` citește doar chei RSA. Driverul PKCS#11 are cale pentru EC, la fel de netestată.

## PKCS#11

`pkcs11js` este o dependență opțională: se instalează separat, fiindcă se compilează pe calculatorul respectiv și cere un compilator C++ și Python.

```bash
npm install pkcs11js
node src/cli.js pkcs11 /usr/lib/libModulFurnizor.so
```

Un PIN greșit pe token nu se reîncearcă automat, deoarece consumă o încercare; cererea se încheie, iar semnarea se reia din aplicație.
