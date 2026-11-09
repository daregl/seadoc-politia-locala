# Contract API SeaDoc (MVP)

Toate rutele au prefixul `/api`, răspund JSON, iar erorile au forma `{ "message": "text în română" }`. JSON-ul trimis are limita de 5 MB, iar fișierele limita de 50 MB (413).
Autentificarea folosește cookie-ul HttpOnly `seadoc_session`. Web-ul apelează cu `credentials: 'same-origin'`.
Datele sunt ISO 8601. Roluri: `admin`, `manager`, `user`, `registratura`, `arhivar`.

## Autentificare (`src/auth.ts`, implementat)

- `POST /auth/login {username,password}` → `{state, user?}`; `state` = `ok` | `mfa` | `mfa_enrol` | `change_password`
- `POST /auth/mfa/verify {code}` → același format. `POST /auth/mfa/enrol` → `{secret, uri, qr}` (`qr` = data URL)
- `GET /auth/me` → același format (401 fără sesiune). `POST /auth/logout`. `POST /auth/password {current,next}`
- `user` = `{id, username, fullName, role, departmentId, departmentName, jobTitle, hasToken, mfaEnabled, mustChangePassword, authSource, permissions[]}`; `authSource` = `local` | `ldap` | `oidc`
- `permissions` ⊂ `register, approve, sign_qualified, workflow_edit, archive, users_admin, audit_all, reports, archive_journal`

## Autentificare centralizată (`src/ldap-client.ts`, `src/ldap.ts`, `src/oidc.ts`)

Ambele sunt dezactivate până la configurarea variabilelor din `.env.example`.

**LDAP/AD.** Un cont cu `auth_source = 'ldap'` se autentifică prin `POST /auth/login`, cu bind în director pe DN-ul găsit de contul de serviciu; parola nu se stochează. Parola goală este refuzată fără bind. Răspunsul este același 401 pentru utilizator necunoscut și parolă greșită. Blocarea și MFA rămân cele din aplicație. Cât timp contul este blocat, directorul nu mai este întrebat.

- Director indisponibil, inclusiv cont de serviciu greșit → 503, fără să conteze la blocare; se scrie `auth.ldap_indisponibil`.
- `POST /auth/password` și `PATCH /admin/users/:id {password}` pe un cont extern → 409. Expirarea parolei nu se aplică acestor conturi. Semnătura internă se confirmă cu parola din director.
- `GET /admin/ldap/status` → `{enabled,url,baseDn,tls,syncIntervalMinutes,groupRoleMap,lastSync,accounts}`
- `POST /admin/ldap/sync {dryRun?,force?}` → `{dryRun,applied,counts,changes,blocked,finishedAt}`. Fără `dryRun: false` doar previzualizează. `counts` = `{directoryUsers,usersCreated,usersUpdated,usersDeactivated,usersReactivated,rolesChanged,departmentsCreated,managersSet,localConflicts,skipped,managersUnresolved}`
  - Se dezactivează conturile LDAP cu bitul 2 din `userAccountControl` sau care lipsesc din director. Conturile locale nu sunt atinse niciodată; un cont local cu același nume apare ca `conflict_cont_local`.
  - Rolul se schimbă doar dacă se aplică `LDAP_GROUP_ROLE_MAP` (primul grup din listă, potrivit exact pe `memberOf`, fără grupuri imbricate).
  - Managerul departamentului este persoana indicată de `manager` la cei mai mulți oameni din departament.
  - 409: director fără niciun utilizator; o sincronizare în curs; lipsa oricărui administrator activ rezultat; dezactivări peste `LDAP_SYNC_MAX_DEACTIVATE_PERCENT` fără `force: true`. 502: directorul nu poate fi citit.
- `POST /admin/ldap/users/:id/source {source:"ldap"|"local",password?}`: mută explicit un cont. Pentru `local`, `password` este temporară. Cere să rămână un administrator local activ.
- Toate `/admin/ldap/*` cer `users_admin`. Audit: `ldap.sincronizare`, `ldap.sursa_cont`.

**OIDC.** Cod de autorizare cu PKCE, `state`, `nonce` și semnătura ID token-ului verificată prin JWKS.

- `GET /auth/sso` (public) → `{oidc, label}`: butonul din pagina de autentificare
- `GET /auth/oidc/start?returnTo` (public) → 302 către furnizor; `returnTo` acceptă doar căi locale
- `GET /auth/oidc/callback` (public) → 302 către `returnTo` sau `/panou`; la eroare, 302 către `/autentificare?sso=eroare|refuzat|necunoscut|blocat|indisponibil`. Starea este de unică folosință și legată de browser printr-un cookie.
- Potrivire: `oidc_subject`, apoi `OIDC_USERNAME_CLAIM`, apoi `email` doar cu `email_verified: true`. Primul `sub` rămâne legat de cont; alt `sub` pe același nume este refuzat. Administratorii locali nu intră prin SSO. Contul se creează doar cu `OIDC_AUTO_CREATE=true`, cu rolul `user`.
- MFA: se consideră făcut doar dacă `amr` conține o valoare din `OIDC_MFA_AMR` sau `acr` este în `OIDC_MFA_ACR`; altfel se aplică regulile aplicației (`mfa`/`mfa_enrol`). Audit: `auth.login` cu `sso`, `auth.oidc_esuat`.

## Date ERP importate (`src/erp.ts`)

Date încărcate din fișiere CSV. Nu există o conexiune cu un sistem ERP: `ErpConnector` are doar implementarea CSV.

- `POST /erp/import/preview` multipart `file` → `{columns,sample,totalRows,malformed,fields}` (`users_admin`)
- `POST /erp/import` multipart `file, kind(partener|factura|comanda), mapping(JSON {camp:coloana}), dryRun?` → `{kind,dryRun,totalRows,created,updated,unchanged,rejected,errors:[{line,reason}],errorsTruncated,unknownPartners}` (`users_admin`). Idempotent după (`kind`, cod extern). Celulele goale nu șterg valori. Câmpuri: `externalId, name, taxId, status` la parteneri; `externalId, number, partnerExternalId, issueDate, dueDate, amount, currency, status` la facturi și comenzi. CSV în UTF-8 sau Windows-1250, cel mult 20 MB. Audit: `erp.import`, o intrare pe import.
- `GET /erp/records?kind&q&limit&offset` → `{total, items:[{id,kind,externalId,source,name,number,taxId,partnerExternalId,partnerId,partnerName,issueDate,dueDate,amount,currency,status,updatedAt}]}`. Oricărui utilizator autentificat.
- `GET /erp/records/:id` → aceleași câmpuri + `documents:[{id,title,regLabel,regDate,status,viaRecordId,viaKind,viaNumber}]`, doar documentele vizibile pentru utilizator, + `related` (facturile și comenzile partenerului).
- `GET /documents/:id/erp-links` → înregistrările legate. `POST /documents/:id/erp-links {recordId}`, `DELETE /documents/:id/erp-links/:recordId` → lista actualizată. Cer vizibilitatea documentului; documentul arhivat = 409. Audit: `erp.legatura`, `erp.legatura_stearsa`.
- `GET /documents?erpRecordId=` filtrează după înregistrare; pentru un partener, și după facturile și comenzile lui.

## Migrarea arhivei (`scripts/migrate-archive.ts`, `src/migration.ts`)

Importul rulează doar din linia de comandă (vezi README). Rutele de mai jos doar citesc și cer `users_admin`:

- `GET /admin/migration/runs` → `[{id,sourceName,sourceRoot,inventoryFile,mode,status,operator,startedAt,finishedAt,counts,report,reportOk,reportAt,hasCsv,hasPdf}]`; `GET /admin/migration/runs/:id` → un rând
- `GET /admin/migration/runs/:id/items?status&limit&offset` → `{total, items}`; implicit doar elementele cu probleme, `status=toate` pentru toate
- `GET /admin/migration/runs/:id/report/csv|pdf`: ultimul raport generat de comanda `report`
- Audit: `migrare.import` sau `migrare.simulare`, câte unul pe rulare; `migrare.element_esuat`, câte unul pe fișier eșuat; `migrare.raport`; `migrare.raport_descarcat`.

## Documente (`src/documents.ts`, implementat)

- `GET /documents?q&number&from&to&typeId&departmentId&folderId&status&direction&issuer&favorites=1&meta.<camp>&limit&offset`
  → `{total, items:[{id,title,direction,regLabel,regDate,issuer,recipient,status,dueDate,createdAt,personalData,typeName,departmentName,folderName,favorite,snippet}]}`.
  `snippet` conține doar marcajele `<mark>` peste text de document: se afișează escapat, cu `<mark>` refăcut.
- `POST /documents` multipart (tipul fișierului se stabilește după extensie și conținut; extensiile necunoscute sunt respinse): `file` + `title, direction(intrat|iesit|intern), registerId?, issuer?, recipient?, summary?, dueDate?, documentTypeId, departmentId?, folderId?, metadata(JSON string), personalData, linkToId?, linkKind(raspuns_la|anexa_la)?` → `{id, regLabel, versionId}`
- `GET /documents/:id` → `{id,title,direction,regLabel,regDate,issuer,recipient,summary,dueDate,status,metadata,personalData,createdAt,archivedAt,retentionUntil,type:{id,name,nomenclatorCode,retentionYears,fields},department,owner,register,folder,ownerId,departmentId,favorite,versions:[{id,versionNo,filename,mime,sizeBytes,sha256,ocrStatus,ocrUsed,hasSearchable,hasFile,createdAt,createdBy}],links:[{kind,dir,id,title,regLabel}],signatures:[{id,kind,sha256,signedAt,signer,versionNo}],duplicates:[{kind:amprenta|text|denumire,score,id?,title?,regLabel?,restricted?}],canEdit,canArchive}`
- `GET /documents/:id/status` → `{versions:[{versionNo,ocrStatus,ocrUsed,hasSearchable}], duplicates}`
- `GET /documents/:id/text` → `{text}`
- `GET /documents/:id/file?version&kind=original|searchable&download=1` → fișierul (inline pentru PDF/PNG/JPEG)
- `POST /documents/:id/versions` multipart `file`. `PUT|DELETE /documents/:id/favorite`
- `POST /documents/:id/links {toId, kind}`. `GET /documents/:id/signatures/verify` → `[{id, kind, valid, certificate?:{verdict,chain,message,testIndicators}}]`; `valid` = conținutul și sigiliul corespund, iar pentru `certificat` și amprenta și CMS-ul din PDF. Nu spune nimic despre statutul calificat.
- `GET /documents/:id/preview?version` → `{kind:"html",format:"docx"|"xlsx"|"pptx",html,truncated,notes:[]}` sau `{kind:"descarcare",message}` (formate binare vechi și alte tipuri). HTML-ul trece pe server printr-o listă de permisiuni: fără scripturi, evenimente, stiluri sau imagini externe; se afișează într-un iframe `sandbox`. Fișier care depășește limitele de timp, memorie sau dezarhivare = 422. Aceeași vizibilitate și același audit ca la `/file`.
- `GET /documents/export/register?registerId&year` → CSV (`register`), cu o coloană pentru motivul anulării
- `POST /documents :confidential=true` marchează documentul confidențial: drepturile largi (pe dosar, tip sau compartiment) și accesul pe compartiment al șefului, registraturii și arhivarului nu îl mai acoperă. Îl văd proprietarul, cei cu drept explicit pe document sau care au primit acces prin flux, și administratorul.
- `POST /documents/:id/cancel {reason}` (cel puțin 5 caractere) anulează înregistrarea: numărul rămâne în registru, documentul devine `anulat` și nu mai primește versiuni, legături, flux sau arhivare. Cere `register`. Se pot anula doar documentele cu număr de înregistrare, în starea `inregistrat`, `aprobat` sau `respins`; în flux sau altă stare = 409. Audit `document.anulat`.
- `GET /documents/:id` adaugă `confidential, cancelReason, cancelledAt, cancelledBy, cases:[{id,kind,regLabel}], canCancel`. `links[].kind` acceptă și `conex`.
- Stări document: `inregistrat, in_flux, aprobat, respins, arhivat, eliminat, anulat`. OCR: `in_asteptare, in_lucru, finalizat, esuat, neaplicabil`

## Semnături în PDF (`src/qualified-sign.ts`, `src/pdf-signatures.ts`; agentul în `apps/agent`)

Verificarea semnăturilor din fișier:

- `POST /documents/:id/pdf-signatures/verify?version` → `{id,versionNo,checkedAt,checkedBy,report}`. Verifică fișierul original al versiunii (implicit ultima), păstrează rezultatul, scrie în audit `document.verificare_semnaturi`. Non-PDF = 400. Fișierul ostil dă `report.status` `malformat` sau `esuat`, nu o eroare de server. Limite: 30 s și 192 MB heap, într-un fir izolat; coadă plină = 503.
- `GET /documents/:id/pdf-signatures` → `[{id,versionNo,checkedAt,checkedBy,report}]`, ultima verificare pe fiecare versiune.
- `report` = `{status: cu_semnaturi|fara_semnaturi|malformat|esuat, message, fileSha256, fileSize, checkedAt, trustRootsConfigured, trustRootsRejected, signatures:[…], truncated, notes}`
- O semnătură = `{index, fieldName, referenced, subFilter, verdict, message, signer:{subject,issuer,commonName,serial,sha256,validFrom,validTo,selfSigned}, testIndicators, signingTime:{value,source: atribut_semnat|dictionar_pdf,note}, digestAlgorithm, signatureAlgorithm, weakAlgorithm, digestMatches, cmsSignatureValid, signingCertificateAttribute, byteRange, byteRangeValid, coversWholeFile, bytesAfterSignature, certificateValidAtSigning, chain:{status: verificat|neverificat|invalid,message,rootFile,rootSubject,certificates}, revocation:{checked:false,message}, qualified:{checked:false,message}, timestamp:{present,verified:false,message}, issues}`
- `verdict`: `valida`, `lant_neverificat`, `lant_invalid`, `modificat_dupa_semnare`, `certificat_nevalabil`, `alterata`, `semnatura_invalida`, `structura_invalida`, `nesuportata`. `valida` cere amprentă și CMS corecte, tot fișierul acoperit, certificat valabil la momentul declarat și lanț până la o rădăcină din `TRUST_ROOTS_DIR`. Fără rădăcină potrivită, mesajul conține „lanț de încredere neverificat”. `revocation.checked` și `qualified.checked` sunt mereu `false`: aplicația nu face aceste verificări. `testIndicators` nevid = certificat de test; gol nu înseamnă certificat real.

Semnătura cu certificat, în două faze (cere `sign_qualified`):

- `GET /signing/config` → `{agentOrigin,sessionTtlSeconds,trustRootsConfigured}`
- `POST /signing/prepare {taskId?,documentId?,certificatePem}` → `{sessionId,digestAlgorithm:"SHA-256",digestHex,byteRange,expiresAt,documentId,taskId,versionNo,filename,label}`. Adaugă semnătura goală prin actualizare incrementală în PDF-ul căutabil al ultimei versiuni sau, dacă nu există, în original. Octeții existenți rămân identici. Cu `taskId`: doar titularul unei sarcini `semnare` deschise. Fără: documentul nu este în flux, iar utilizatorul poate adăuga versiuni. Non-PDF, PDF criptat, certificat expirat sau malformat = 400; OCR în curs sau document arhivat = 409. O pregătire nouă o anulează pe cea anterioară a aceluiași utilizator pe același document.
- `POST /signing/sessions/:id/complete {cms,comment?}` (`cms` în base64) → `{signatureId,versionId,versionNo,sha256,task:{taskId,status,instanceStatus}|null,signature,testCertificate}`. Verifică CMS-ul peste octeții pregătiți, că semnatarul este certificatul declarat și că este în perioada de valabilitate. Rezultatul este o versiune nouă, cu textul versiunii de bază, fără OCR și fără regula `canAddVersion`, deoarece semnătura nu schimbă conținutul. Altă persoană decât cea care a pregătit = 403. Sesiune expirată = 410 (implicit 5 minute, `SIGN_SESSION_TTL_SECONDS`). CMS invalid, altă amprentă sau alt certificat = 400. Sesiune folosită, versiune nouă apărută între timp sau sarcină închisă = 409. Cu `taskId`, sarcina se finalizează în aceeași tranzacție.
- `signatures[].kind` = `interna` | `certificat`; `GET /documents/:id` adaugă `certificateSubject, certificateIssuer, testIndicators, chainStatus, verdict`.
- Audit: `semnatura.pregatita`, `semnatura.respinsa`, `semnatura.sesiune_straina`, `document.semnatura_certificat`.

## Notificări (`src/notifications.ts`, implementat)

`GET /notifications` → `{unread, items:[{id,kind,title,documentId,taskId,link,readAt,createdAt}]}`; `POST /notifications/read-all`; `POST /notifications/:id/read`. `link` este o rută din interfață (de exemplu `/lucrari/12`, `/intranet`) pentru notificările care nu țin de un document.

## Email (`src/mail.ts`, `src/mail-inbox.ts`)

Trimitere. `NotificationService.send` adaugă, în aceeași tranzacție cu notificarea, un rând în `email_outbox`, dacă SMTP este configurat și utilizatorul activ are adresă. Lucrătorul pornit din `main()` trimite separat, prin nodemailer, doar text: titlul notificării și un link (`APP_URL`). Stări: `in_asteptare`, `trimis`, `esuat`, `ignorat`. Se fac cel mult 8 încercări, cu întârzieri de 1, 2, 4... minute (maximum 1 oră); refuzul definitiv al destinatarului (5xx la RCPT) oprește reîncercările. Adresele `.invalid` și cele care nu sunt o singură adresă simplă devin `ignorat`, fără conexiune la server.

- `GET /mail/status` → `{smtp:{enabled,host,from,appUrl}, counts:{in_asteptare?,trimis?,esuat?,ignorat?}}` (`users_admin`, ca și rutele de mai jos)
- `GET /mail/outbox?status&limit&offset` → `{total, items:[{id,toAddress,userName,subject,kind,documentId,status,attempts,nextAttemptAt,lastError,createdAt,sentAt}]}`
- `POST /mail/outbox/:id/retry`: doar pentru `esuat` (altfel 409); repune mesajul în coadă, cu încercările de la zero

Primire (toate cer `register`). Lucrătorul citește căsuța IMAP. La prima rulare ia doar mesajele necitite, apoi tot ce are UID mai mare. Marchează numai `\Seen`; nu mută și nu șterge. Dublurile se recunosc după `Message-ID`, sau după amprenta mesajului când acesta lipsește. Din mesaj se păstrează textul, niciodată HTML-ul. Atașamentele trec prin aceeași validare ca la încărcare și se stochează criptat; cele refuzate rămân în listă, cu motivul, fără conținut.

- `GET /mail/inbox?status=nou|inregistrat|renuntat&limit&offset` → `{total, items:[{id,fromName,fromAddress,toText,subject,sentAt,importedAt,status,importNote,handledAt,handledBy,registered,documentId,regLabel,attachmentCount,refusedCount}], imap:{enabled,mailbox,lastPollAt,lastSuccessAt,lastError}}`. `documentId` și `regLabel` sunt `null` pentru cine nu are acces la document.
- `GET /mail/inbox/:id` → aceleași câmpuri + `{bodyText,bodyTruncated,attachmentId,discardReason,attachments:[{id,filename,mime,sizeBytes,refusedReason,available}]}`. `bodyText` este text simplu; se afișează escapat.
- `GET /mail/inbox/:id/attachments/:attachmentId` → fișierul, mereu cu `Content-Disposition: attachment`. Atașament refuzat = 409.
- `POST /mail/inbox/:id/register {attachmentId, title, documentTypeId, ...câmpurile din POST /documents}` → `{id, regLabel, versionId}`. Aceleași validări ca `POST /documents`; `direction` implicit `intrat`. Mesajul se leagă de document în aceeași tranzacție; mesaj deja tratat = 409.
- `POST /mail/inbox/:id/discard {reason?}`: mesajul devine `renuntat`, copia locală a atașamentelor se șterge, originalul rămâne pe server. Mesaj deja tratat = 409.
- `POST /mail/inbox/poll` → `{imported,duplicates,refusedAttachments,remaining}`. IMAP neconfigurat = 409; căsuță indisponibilă = 502.

Audit: `email.trimis`, `email.esuat`, `email.retrimitere`, `email.importat`, `email.duplicat`, `email.import_esuat`, `email.atasament_refuzat`, `email.atasament_descarcat`, `email.vizualizare`, `email.inregistrat`, `email.renuntat`. Jurnalul nu conține expeditorul sau subiectul.

## Fluxuri (`src/workflow-engine.ts`, `src/workflows.ts`)

Definiții (versionate pe `key`; publicarea creează o versiune nouă, instanțele active rămân pe versiunea lor):

- `GET /workflows` → `[{id,key,version,name,description,departmentId,departmentName,canEdit,createdAt}]` (ultima versiune per key)
- `GET /workflows/:key` → aceleași câmpuri + `xml`. `GET /workflows/:key/versions` → `[{version,createdAt,createdBy}]`
- `POST /workflows {key?,name,description?,departmentId?,xml}` → publică. Cere `workflow_edit`; managerul doar pe departamentul lui.
  XML invalid → 400 cu `{message, errors:[...]}`. `POST /workflows/validate {xml}` → `{errors:[...]}`
- `GET /workflows/assignee-options` → `{jobTitles:[], roles:[], users:[{id,username,fullName,jobTitle,departmentName}], departments:[{id,name}]}`. Oricărui utilizator autentificat; conține doar utilizatorii activi cu drept `approve`, adică pe cei care pot primi o sarcină.

Elemente BPMN acceptate: `startEvent, endEvent, userTask, parallelGateway, exclusiveGateway, sequenceFlow`. Orice alt element = eroare de validare.
Extensie (namespace `http://seadoc.ro/schema/bpmn`, prefix `seadoc`), atribute pe `userTask`:

| Atribut | Valori |
| --- | --- |
| `seadoc:assigneeType` | `functie` (funcție din organigramă), `rol`, `utilizator`, `manager_departament` (managerul departamentului documentului), `initiator` |
| `seadoc:assignee` | valori separate prin virgulă; funcții, roluri sau username-uri; gol pentru ultimele două tipuri |
| `seadoc:action` | `avizare` (implicit), `aprobare`, `semnare`, `informare` |
| `seadoc:dueHours` | ore până la termen (număr; absent = fără termen) |
| `seadoc:completion` | `all`, `any` (implicit), `majority`; se aplică sarcinilor create pentru fiecare persoană rezolvată |

Pe `sequenceFlow` care iese dintr-un `exclusiveGateway`: `seadoc:condition` = `camp = valoare` (camp din metadate, sau `tip`, `departament`; comparație fără majuscule); calea fără condiție (sau `default` pe gateway) este calea implicită. Poarta cu ieșiri trebuie să aibă o cale implicită, altfel validarea o respinge.

Titularii numiți (`functie`, `rol`, `utilizator`) trebuie să fie utilizatori activi cu drept `approve`; validarea îi listează pe cei care lipsesc. La execuție, un pas fără titular valid ajunge la managerul departamentului, apoi la un administrator, cu audit `flux.titular_lipsa`.

Instanțe și sarcini:

- `POST /workflows/:key/start {documentId}` → `{instanceId}`. Cere vizibilitate și (`register` sau proprietar). Un singur flux activ per document (409). Document arhivat = 409.
- `GET /documents/:id/workflow` → `{instances:[{id,status,version,name,startedBy,startedAt,finishedAt,xml,steps:[{elementId,elementType,name,status,startedAt,finishedAt}],tasks:[{id,elementId,name,kind,status,assignee,dueAt,overdue,comment,completedAt}]}]}` (cea mai nouă prima). Stările pentru diagramă se calculează din `steps`.
- `GET /tasks?scope=open|done` → `[{id,documentId,documentTitle,regLabel,name,kind,status,dueAt,overdue,createdAt,workflowName,instanceId,comment}]` (sarcinile mele). `open` include și `asteapta_completare`, care nu se poate acționa până la revenire; `comment` conține, pe o sarcină `completare`, întrebarea la care se răspunde.
- `POST /tasks/:id/action {action, comment?, password?, targetUserId?}` → `{taskId,status,instanceStatus}`. Sarcină care nu mai este deschisă = 409. Parolă greșită = 401, fără nicio modificare.
  - `approve`: avizare/aprobare/informare/completare. Pentru `semnare` trebuie `action: "sign"` cu `password`, care creează semnătură internă, sau semnătura cu certificat prin `/signing/*`.
  - `reject`: `comment` obligatoriu; termină fluxul conform regulii de completare, doc `respins`.
  - `redirect`: `targetUserId` obligatoriu; ținta trebuie să fie activă, cu drept `approve` (mai puțin la `completare`) și fără altă sarcină deschisă pe același pas. `request_info`: `comment` obligatoriu; creează o sarcină `completare` pentru inițiator, sarcina originală devine `asteapta_completare` și revine la finalizarea completării. O sarcină `completare` se finalizează doar cu `approve` sau `redirect`.
  - Doar titularul sarcinii. Cere `approve`, cu excepția sarcinilor `completare`.
- `GET /dashboard` → `{tasks:[...ca /tasks, doar deschise], pendingDocuments:[{id,title,regLabel,status,createdAt}], dueThisWeek:[{id?,title,dueAt,kind:"sarcina"|"document",documentId}], counts:{openTasks,overdueTasks,pending}}`

Comportament: la activarea unui pas se acordă `document_access` titularilor, se trimit notificări; înlocuitorul activ (`substitute_id` + `substitute_until`) primește sarcina în locul titularului. Termene: notificare `termen_apropiat` cu 24 h înainte, iar la depășire notificare titularului și managerului departamentului plus `escaladat`. Fluxul aprobat → document `aprobat`; respins → `respins` + notificare către inițiator; sarcinile deschise se anulează. Dacă nu mai există pași activi, dar un token a rămas la o poartă paralelă care nu se mai poate completa, fluxul se încheie `respins`, cu audit `flux.blocat`.

Tipuri de notificare: `sarcina_noua`, `completare_ceruta`, `completare_finalizata`, `termen_apropiat`, `termen_depasit`, `document_aprobat`, `document_respins`.

## Administrare (`src/admin.ts`)

- `GET /meta` → `{departments:[{id,name,parentId,managerId,managerName}], documentTypes:[{id,name,nomenclatorCode,retentionYears,fields:[{key,label,type:"text"|"date"|"number",required}]}], registers:[{id,name,code,departmentId,documentTypeId,active}], folders:[{id,name,parentId,departmentId}], users:[{id,fullName,jobTitle,departmentName}]}`. Oricărui utilizator autentificat.
- `POST /admin/document-types`, `PATCH /admin/document-types/:id`; `POST /admin/registers`, `PATCH /admin/registers/:id`; `POST /admin/folders`; `POST /admin/departments`, `PATCH /admin/departments/:id {name?,parentId?,managerId?}`
- `GET /admin/users`, `POST /admin/users {username,fullName,email?,password,role,departmentId?,jobTitle?,hasToken?}`, `PATCH /admin/users/:id {fullName?,email?,role?,departmentId?,jobTitle?,hasToken?,active?,substituteId?,substituteUntil?,permissions?:{perm:boolean},password?}`
- `GET /admin/grants?userId`, `POST /admin/grants {userId,scope,targetId}`, `DELETE /admin/grants/:id`
- `GET /admin/settings` → `{passwordPolicy:{minLength,requireComplexity,expiryDays,maxFailedAttempts,lockMinutes}, internalNetworks:[cidr]}`; `PUT /admin/settings/password-policy` (oricare dintre câmpurile politicii; întoarce politica salvată); `PUT /admin/settings/internal-networks {networks:[cidr]}` → `{networks}`
- Toate `/admin/*` cer `users_admin`. Fiecare modificare se scrie în audit.
- Răspunsuri: fiecare `POST`/`PATCH` întoarce rândul rezultat, cu aceleași câmpuri ca în `/meta` sau `/admin/users`. `GET /admin/users` → `[{id,username,fullName,email,role,departmentId,departmentName,jobTitle,hasToken,active,mfaEnabled,mustChangePassword,lockedUntil,substituteId,substituteName,substituteUntil,permissions}]`; `GET /admin/grants` → `[{id,userId,userName,scope,targetId,targetName}]`.
- `permissions` în `PATCH` se aplică peste ajustările existente; `null` pe o permisiune readuce valoarea din rol.
- Parola setată de administrator (la creare sau resetare) este temporară: contul primește `mustChangePassword`, iar resetarea închide sesiunile deschise. Parola proprie se schimbă doar prin `POST /auth/password`.
- Reguli (409): administratorul nu își poate dezactiva contul; trebuie să rămână cel puțin un `admin` activ cu `users_admin`, inclusiv la retrogradare sau la retragerea permisiunii.

## Audit și rapoarte (`src/reports.ts`)

- `GET /audit?documentId&userId&action&from&to&limit&offset` → `{total, items:[{seq,at,username,action,documentId,ip,details,hash}]}`. `audit_all` vede tot; `archive_journal` doar acțiuni `arhiva.*`. `action` este o acțiune exactă sau un grup (`arhiva` = `arhiva.*`).
- `GET /audit/export?...` → CSV. `GET /audit/verify` → `{ok,checked,brokenAt}` (`audit_all`)
- `GET /gdpr/access-log?...` → ca `/audit`, doar `gdpr.*` (`audit_all`)
- `GET /reports/summary?departmentId` → `{byStatus:[{departmentName,status,count}], resolution:[{departmentName,avgHours,count}], overdue:[{taskId,documentId,title,assignee,dueAt}]}`; managerul doar pe departamentul lui, cere `reports`. `resolution` = media dintre pornirea și încheierea fluxurilor, pe departamentul documentului.

## Cereri GDPR (`src/gdpr-requests.ts`)

Toate cer `audit_all`. `type` = `acces, rectificare, stergere, restrictionare, opozitie, portabilitate`; `status` = `inregistrata, in_lucru, solutionata, respinsa`. Termenul `dueOn` = `receivedOn` + 30 de zile, calculat de baza de date.

- `GET /gdpr/requests?status&overdue=1&limit&offset` → `{total, overdue, items:[{id,type,subjectName,subjectIdentifier,receivedOn,dueOn,status,resolutionNote,assigneeId,assigneeName,createdBy,createdAt,closedAt,overdue,daysLeft}]}`; cele depășite primele
- `POST /gdpr/requests {type,subjectName,subjectIdentifier?,receivedOn,assigneeId?}` → cererea. Dată în viitor = 400.
- `GET /gdpr/requests/assignees` → `[{id,fullName}]`: utilizatorii activi cu `audit_all`
- `GET /gdpr/requests/:id` → cererea + `decisions:[{documentId,decision,note,retentionUntil,documentStatus,decidedBy,decidedAt,title,regLabel}]`
- `PATCH /gdpr/requests/:id {type?,subjectName?,subjectIdentifier?,receivedOn?,assigneeId?,resolutionNote?,status?}`. Închiderea (`solutionata`, `respinsa`) cere notă de soluționare.
- `GET /gdpr/requests/:id/search?scope=all` → `{scope,limit,total,notVisible,items:[{id,title,regLabel,status,personalData,retentionUntil,archivedAt,typeName,departmentName,retentionActive,decision,decisionNote}]}`. Căutare full-text după nume sau identificator. Implicit doar documentele cu date personale; `scope=all` le include pe toate. Rezultatele respectă accesul utilizatorului; `notVisible` spune câte au rămas în afara lui.
- `GET /gdpr/requests/:id/export?scope=all` → CSV: datele cererii, documentele găsite și jurnalul de acces al acelor documente
- `PUT /gdpr/requests/:id/decisions/:documentId {decision,note?}` → consemnează decizia, cu `decision` = `pastrare_retentie, eliminare_la_expirare, fara_legatura, alta` (`alta` cere notă). Documentul nu se modifică și nu se șterge. Cerere închisă = 409.

Audit: `gdpr.cerere_creata`, `gdpr.cerere_modificata`, `gdpr.cerere_consultata`, `gdpr.cerere_cautare`, `gdpr.cerere_export`, `gdpr.cerere_decizie`. Jurnalul nu conține numele sau identificatorul persoanei. Aceste rânduri apar și în `GET /gdpr/access-log`, care întoarce tot `gdpr.*`.

## Arhivă (`src/archive.ts`)

- `POST /documents/:id/archive` închide și arhivează: `retention_until` = azi + `retention_years` din tip (NULL = permanent). Permis pentru `archive`, proprietar, sau managerul departamentului; nu cât timp are flux activ sau cât timp extragerea OCR este în curs (409, reîncercare ulterioară). → `{id,status,archivedAt,retentionUntil}`
- `GET /archive?q&typeId&expired=1&limit&offset` → `{total, items:[{id,title,regLabel,status,typeName,nomenclatorCode,archivedAt,retentionUntil,expired,proposalStatus}]}` (cere `archive`). Include și documentele `eliminat`; `expired=1` le lasă doar pe cele `arhivat` cu termenul depășit. `proposalStatus` este starea ultimei propuneri.
- `GET /archive/proposals` → `[{id,documentId,title,regLabel,retentionUntil,reason,proposedBy,proposedAt,status,decidedBy,decidedAt}]` (cere `archive`, ca și rutele de mai jos)
- `POST /archive/proposals {documentId,reason?}`: doar dacă termenul a expirat
- `POST /archive/proposals/:id/decide {approve:boolean}`: decide altă persoană decât cea care a propus. Aprobat → fișierele se șterg din stocare, documentul devine `eliminat`, textul extras se golește, metadatele și hash-urile rămân.

## Lucrări: petiții, informații publice, contravenții, control (`src/cases.ts`)

O lucrare grupează documentele, termenele și pașii unui caz. `kind` = `petitie` (O.G. nr. 27/2002, prefix `P`), `informatii_publice` (Legea nr. 544/2001, `I`), `contraventie` (O.G. nr. 2/2001, `DC`), `control` (acțiune de control, `AC`). Numerotarea este anuală, pe tip: `P-00001/2026`. Stări: `deschisa`, `inchisa`.

Vizibilitate: `cases_all` (admin, registratură) vede tot. Ceilalți văd lucrările create de ei, repartizate lor (sau un obiect al lor) și pe cele ale compartimentelor pe care le conduc. Un șef vede și compartimentele subordonate din organigramă, așa că șeful compartimentului rădăcină vede toată instituția.

Termenul (`dueOn`, calculat în SQL):
- petiție: 30 de zile de la înregistrare, plus prelungirea (o singură dată, 1–15 zile);
- informații publice: 10 zile, prelungite la 30 doar în primele 10 zile; refuzul motivat se comunică în 5;
- contravenție: 2 luni de la aplicare, pentru comunicarea procesului-verbal; după comunicare nu mai există termen al instituției;
- control: termenul stabilit manual (`manualDueOn`).

`readyForExecution` marchează amenzile neachitate și netrimise spre executare, dacă au trecut 15 zile de la comunicare fără plângere sau dacă plângerea a fost respinsă ori admisă parțial.

- `GET /cases?kind&status=deschisa|inchisa|toate&q&mine=1&overdue=1&readyForExecution=1&assigneeId&departmentId&from&to&limit&offset` → `{total, items:[{id,kind,regLabel,subject,applicantName,location,receivedOn,dueOn,daysLeft,overdue,status,outcome,assigneeName,departmentName,…}]}`
- `POST /cases {kind, subject, receivedOn?, departmentId?, assigneeId?, documentId?, parentId?, applicantName?, applicantAddress?, applicantEmail?, applicantPhone?, anonymous?, channel?, location?, manualDueOn?, objects?:[text|{text,departmentId?,assigneeId?}], details?, contravention?}`
  - Petițiile și cererile 544 le înregistrează doar `register` sau `cases_all`. Numele petentului e obligatoriu, cu excepția petiției anonime.
  - Controlul cere `location`.
  - `contravention` = `{pvSeries, pvNumber, offenderName, offenderIdCode?, offenderAddress?, fact, legalBasis, sanction: amenda|avertisment, amount?, minAmount?, agentId?, observedAt?, appliedOn?, communicatedOn?, communicationMethod?: inmanare|posta|afisare}`. Seria și numărul sunt unice.
  - La contravenție și control, responsabilul implicit este cel care înregistrează.
  - Data înregistrării în viitor = 400.
- `GET /cases/:id` → lucrarea, cu `objects`, `documents:[{documentId,regLabel,title,role,status}]`, `events`, `photos`, `dispatches`, `deadlines:[{key,label,date,met}]`, `contravention` (pentru `DC`), `children` (lucrări conexate), `templates` (șabloanele potrivite tipului), `outcomes` (soluțiile posibile), `canEdit`, `canExtend`, `extensionHint` (de ce nu se poate prelungi).
- `PATCH /cases/:id {subject?, applicant*?, channel?, location?, manualDueOn? (doar control), details?}`. `details` se combină cu cel existent; la control, `details.findings` reține constatările.
- `POST /cases/:id/assign {assigneeId?, departmentId?, note?}`: `note` este rezoluția. Notifică responsabilul.
- `POST /cases/:id/extend {days?, reason}`: petiție 1–15 zile, o dată; cererea 544 trece la 30 de zile, doar în primele 10. Altfel = 409.
- `POST /cases/:id/close {outcome, note, redirectedTo?, parentId?}`. Soluții:
  - petiție: `favorabil, nefavorabil, partial, redirectionata, clasata, conexata`;
  - informații publice: `comunicat, partial, refuz, redirectionata, inexistenta`;
  - contravenție: `achitat, executare, anulat_instanta, avertisment, prescris`;
  - control: `fara_deficiente, masuri_dispuse, sanctiuni_aplicate`.
  - Reguli: `redirectionata` cere `redirectedTo`. `conexata` cere `parentId`, o lucrare de același tip. Soluțiile pe fond (`favorabil`, `nefavorabil`, `partial`, `comunicat`) cer toate obiectele soluționate. `achitat` cere data plății, iar `executare` cere trimiterea spre executare.
- `POST /cases/:id/reopen {reason}`; `POST /cases/:id/notes {note}`
- `POST /cases/:id/objects {text, departmentId?, assigneeId?}`; `PATCH /cases/:id/objects/:objectId {answer?, status?: deschis|solutionat, assigneeId?, departmentId?}`. `solutionat` cere răspuns.
- `POST /cases/:id/documents {documentId, role}`, cu `role` = `principal, raspuns, adresa, proces_verbal, plangere, hotarare, dovada, anexa, alt`
- `POST /cases/:id/photos` multipart: `file` (JPEG sau PNG), `latitude?`, `longitude?`, `note?`. `GET /cases/:id/photos/:photoId` întoarce imaginea, cu audit.
- `PATCH /cases/:id/contravention {communicatedOn?, communicationMethod?, paidOn?, paidAmount?, complaintFiledOn?, court?, courtFile?, decisionOn?, decisionOutcome?: plangere_respinsa|plangere_admisa|admisa_partial|inlocuire_avertisment, executionSentOn?, executionBody?}`. Validări:
  - nicio dată nu e în viitor și niciuna nu e înaintea aplicării;
  - hotărârea cere plângere;
  - amenda achitată și avertismentul nu se trimit spre executare;
  - trimiterea spre executare cere organul de executare.
- `GET /cases/history?location=` (cel puțin 3 caractere) → `{location, cases:[…], documents:[…]}`. Adresa se împarte în cuvinte, iar fiecare cuvânt trebuie să apară, fără diacritice, în locul sau adresa petentului din lucrare. Documentele se caută full-text. Rezultatele respectă vizibilitatea.
- `GET /cases/dashboard` → `{scope: institutie|serviciu|personal, byDepartment, byKind:[{kind,open,overdue,dueSoon,readyForExecution}], urgent:[…], breakdown:[{label,open,overdue}], unassigned, closedThisMonth}`. `breakdown` e pe compartimente pentru conducere și pentru șefii cu subordonate, pe responsabili pentru ceilalți șefi.
- `GET /cases/reports/petitions?year&semester` → situația semestrială (art. 13 din O.G. nr. 27/2002): `{year, semester, from, to, institution, totals:{total,open,inTerm,overTerm,extended,anonymous,multipleObjects,communicated}, byOutcome, byDepartment, byChannel, byMonth}`. `…/csv` dă același conținut ca fișier. Cere `reports` sau `cases_all`.

Termene: planificatorul (`SCHEDULER_MS`) trimite o notificare cu 3 zile înainte de termen și una de escaladare la depășire, către responsabil și șeful compartimentului, fiecare o singură dată. Prelungirea sau redeschiderea le resetează.

Audit: `lucrare.inregistrata`, `lucrare.modificata`, `lucrare.repartizata`, `lucrare.termen_prelungit`, `lucrare.inchisa`, `lucrare.redeschisa`, `lucrare.document_adaugat`, `lucrare.fotografie`, `lucrare.fotografie_vizualizata`, `lucrare.contraventie_actualizata`.

### Șabloane și documente generate

- `GET /templates?kind` → `[{id,code,name,caseKind,caseRole,title,body,documentTypeId,registerId,active,fields}]`. Câmpurile se scriu în text ca `{{camp}}`.
- `POST /templates {code,name,caseKind?,caseRole,title,body,documentTypeId?,registerId?,active?}` și `PUT /templates/:id {…}` (cer `users_admin`)
- `GET|PUT /templates/institution {name,address,phone,email,leader,leaderTitle}`: antetul documentelor. `PUT` cere `users_admin`.
- `GET /cases/:id/templates/:templateId` → `[{key,label,value}]`: câmpurile completate din lucrare
- `GET /cases/:id/templates/:templateId/preview?values=<JSON>` → PDF-ul, fără înregistrare
- `POST /cases/:id/generate {templateId, documentTypeId?, registerId?, title?, values?}` → `{id, regLabel}`. PDF-ul cu antet se înregistrează ca document (`iesit`, sau `intern` pentru procese-verbale), se leagă de lucrare cu rolul șablonului și apare ca eveniment.

### Expediere și dovada comunicării

- `GET /documents/:id/dispatches`; `POST /documents/:id/dispatches` sau `POST /cases/:id/dispatches {documentId?, method, recipient, address?, sentOn?, tracking?, note?, isAnswer?}`
  - `method` = `posta, posta_recomandata, email, curier, inmanare, fax, afisare`.
  - Înmânarea, emailul și afișarea se consideră primite în ziua trimiterii.
  - `isAnswer` marchează răspunsul către petent și intră în `communicated` din situația semestrială.
  - Documentul anulat nu se expediază.
- `POST /dispatches/:id/delivered` multipart `{deliveredOn?, file?}`: confirmarea de primire, cu dovada scanată opțională. `GET /dispatches/:id/proof` întoarce dovada.

## Intranet (`src/intranet.ts`)

- `GET /intranet?kind=anunt|procedura&all=1` → anunțurile vizibile utilizatorului (generale sau ale compartimentului său, neretrase, neexpirate), cu `readAt`, `acknowledgedAt`, `ackCount`. `all=1` (cere `intranet_publish`) le include și pe cele retrase sau expirate.
- `POST /intranet {kind, title, body, departmentId?, documentId?, pinned?, requiresAck?, expiresOn?}` (cere `intranet_publish`: admin, manager) → `{id, notified}`.
  - Fără `departmentId`, anunțul este general.
  - Un șef publică doar pentru compartimentul lui. Conducerea (compartimentul cu subordonate) și administratorul publică și anunțuri generale.
  - Destinatarii primesc notificare.
- `POST /intranet/:id/read {acknowledge?}`: citire sau confirmare de luare la cunoștință
- `GET /intranet/:id/acknowledgements` → `[{fullName,departmentName,readAt,acknowledgedAt}]`; `DELETE /intranet/:id` retrage anunțul (autorul sau admin)

## Tokenuri de API pentru integrări (`src/intranet.ts`, `src/auth.ts`)

- `GET /admin/api-tokens`, `POST /admin/api-tokens {name, userId, expiresOn?}` → `{id, token}`, `DELETE /admin/api-tokens/:id` (revocare). Toate cer `users_admin`.
- Tokenul (`sd_…`) se afișează o singură dată; baza păstrează doar SHA-256.
- Se trimite ca `Authorization: Bearer sd_…`. Cererea are drepturile contului legat, fără cookie, MFA sau CSRF. Tokenul revocat, expirat sau al unui cont inactiv = 401.

## Export complet (`scripts/export-full.ts`)

`npm run export:full -w @seadoc/api -- <director>` scrie:
- câte un CSV pentru fiecare tabel, cu secretele înlocuite;
- fișierele decriptate, cu numele lor originale;
- `manifest.json`, cu SHA-256 pentru fiecare fișier;
- `CITESTE.txt`, care descrie structura.

Exportul servește la predarea datelor la încetarea contractului.
