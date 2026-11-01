// Conținutul documentelor demonstrative. Persoanele, furnizorii, numerele și valorile sunt fictive.

export interface SeedDocument {
  key: string;
  title: string;
  type: string;
  register: string;
  department: string;
  folder: string;
  /** Cine înregistrează documentul; trebuie să aibă dreptul `register`. */
  by: string;
  direction: 'intrat' | 'iesit' | 'intern';
  issuer?: string;
  recipient?: string;
  summary: string;
  dueInDays?: number;
  metadata?: Record<string, string>;
  personalData?: boolean;
  lines?: string[];
  paragraphs: string[];
  favoriteBy?: string[];
  linkTo?: { key: string; kind: 'raspuns_la' | 'anexa_la' };
  /** expired = arhivat în `year`, cu termenul deja depășit; current = arhivat acum, cu termenul din tip. */
  archive?: { mode: 'expired'; year: number } | { mode: 'current' };
}

/** Procedura din care se generează și `samples/duplicat-procedura.pdf`. */
export const RECLAMATII_KEY = 'procedura-reclamatii';

const verificareZilnica = (revizie: string, extra: string): string[] => [
  `Prezenta procedură stabilește modul în care conducătorul auto verifică autobuzul înainte de ieșirea pe traseu. Se aplică la toate autobazele și întregului parc activ. Ediția 1, revizia ${revizie}.`,
  'Înainte de plecare, conducătorul auto controlează nivelul de ulei și de lichid de răcire, presiunea din anvelope, starea farurilor și a semnalizatoarelor, funcționarea ștergătoarelor, a ușilor și a validatoarelor. Sistemul de frânare se probează la viteză redusă, în incinta autobazei, înainte de ieșirea pe poartă.',
  'Rezultatul verificării se trece în foaia de parcurs și se confirmă prin semnătură. Orice defect care afectează siguranța circulației se anunță imediat dispecerului, iar vehiculul nu părăsește autobaza până la remedierea constatată de mecanicul de serviciu.',
  extra,
];

export const SEED_DOCUMENTS: SeedDocument[] = [
  // SSM ---------------------------------------------------------------------
  {
    key: 'ip-conducere-autobuz', title: 'Instrucțiune proprie SSM pentru conducătorii auto de autobuz', type: 'Instrucțiune SSM', register: 'SSM', department: 'SSM', folder: 'Instrucțiuni proprii',
    by: 'manager.ssm', direction: 'intern', issuer: 'Serviciul SSM', summary: 'Reguli de securitate și sănătate în muncă pentru conducătorii de autobuz.', favoriteBy: ['manager.ssm', 'admin.demo'],
    metadata: { cod_instructiune: 'IP-SSM-01', data_revizie: '2026-02-16' }, lines: ['Cod: IP-SSM-01 · Ediția 3 · Aprobată de conducerea societății'],
    paragraphs: [
      'Instrucțiunea se aplică tuturor conducătorilor auto care lucrează pe liniile de autobuz și completează prevederile legislației privind securitatea și sănătatea în muncă. Respectarea ei este obligatorie și se verifică la instruirea periodică.',
      'Conducătorul auto se prezintă la serviciu odihnit, fără să fi consumat alcool sau medicamente care reduc atenția. Înainte de începerea cursei își reglează scaunul și oglinzile, își fixează centura de siguranță și verifică existența trusei medicale, a extinctorului și a triunghiurilor reflectorizante.',
      'În caz de agresiune din partea călătorilor, conducătorul oprește vehiculul într-un loc sigur, anunță dispeceratul și nu părăsește cabina decât dacă pericolul o impune. La accident de circulație, asigură locul faptei, acordă primul ajutor și informează imediat șeful de autobază.',
      'Pauzele de conducere prevăzute în graficul de lucru se respectă întocmai. Se interzice folosirea telefonului mobil în timpul mersului, cu excepția stației radio a dispeceratului.',
    ],
  },
  {
    key: 'ip-hala-reparatii', title: 'Instrucțiune proprie SSM pentru lucrul în hala de reparații', type: 'Instrucțiune SSM', register: 'SSM', department: 'SSM', folder: 'Instrucțiuni proprii',
    by: 'manager.ssm', direction: 'intern', issuer: 'Serviciul SSM', summary: 'Lucrul la canalul de vizitare, ridicarea vehiculelor și sudura.',
    metadata: { cod_instructiune: 'IP-SSM-04', data_revizie: '2025-11-03' }, lines: ['Cod: IP-SSM-04 · Ediția 2'],
    paragraphs: [
      'Mecanicii și electricienii din hala de reparații poartă salopetă, bocanci cu bombeu metalic și ochelari de protecție. Echipamentul individual se verifică la începutul schimbului, iar cel deteriorat se înlocuiește de la magazia de protecție.',
      'Înainte de coborârea în canalul de vizitare, vehiculul se asigură cu frâna de staționare și cu pene de roată. Pe volan se atârnă plăcuța „Nu porniți motorul”. Iluminatul portativ folosit în canal are tensiunea redusă de 24 V.',
      'Ridicarea cu elevatorul se face numai de personal autorizat, fără ca vreo persoană să se afle sub sarcină. Sudura se execută în spațiu ventilat, după îndepărtarea materialelor inflamabile, cu extinctor la îndemână și cu permis de lucru cu foc semnat de șeful atelierului.',
    ],
  },
  {
    key: 'ip-retea-contact', title: 'Instrucțiune proprie SSM pentru lucrări la rețeaua de contact a tramvaiului', type: 'Instrucțiune SSM', register: 'SSM', department: 'SSM', folder: 'Instrucțiuni proprii',
    by: 'manager.ssm', direction: 'intern', issuer: 'Serviciul SSM', summary: 'Lucrul la înălțime și sub tensiune la rețeaua de contact.',
    metadata: { cod_instructiune: 'IP-SSM-07', data_revizie: '2026-05-12' }, lines: ['Cod: IP-SSM-07 · Ediția 1'],
    paragraphs: [
      'Lucrările la rețeaua de contact de 750 V curent continuu se execută numai pe baza autorizației de lucru și a dispoziției energeticianului de serviciu. Echipa are cel puțin doi electricieni, dintre care unul este șef de lucrare cu grupa de autorizare corespunzătoare.',
      'Tronsonul se scoate de sub tensiune de la substația de tracțiune, se verifică lipsa tensiunii și se montează scurtcircuitoarele de punere la pământ. Abia apoi se urcă pe autoplatformă. Muncitorii folosesc centură de siguranță, cască cu vizieră și mănuși electroizolante verificate în termen.',
      'Zona de lucru de pe carosabil se semnalizează conform planului avizat de poliția rutieră. Lucrările se opresc la vânt puternic, furtună sau polei. Repunerea sub tensiune se face numai după confirmarea scrisă a șefului de lucrare că toți oamenii s-au retras.',
    ],
  },
  {
    key: 'instr-prim-ajutor', title: 'Instrucțiune privind acordarea primului ajutor la locul de muncă', type: 'Instrucțiune SSM', register: 'SSM', department: 'SSM', folder: 'Instrucțiuni proprii',
    by: 'manager.ssm', direction: 'intern', issuer: 'Serviciul SSM', summary: 'Conduita în caz de accidentare, truse medicale și apelul 112.',
    metadata: { cod_instructiune: 'IP-SSM-11', data_revizie: '2024-09-20' },
    paragraphs: [
      'În caz de accidentare, martorul oprește sursa de pericol, apelează numărul unic 112 și anunță conducătorul locului de muncă. Victima nu se mișcă decât dacă rămânerea pe loc îi pune viața în pericol.',
      'Hemoragiile se opresc prin compresie directă cu pansament steril. La arsuri, zona afectată se răcește cu apă curată timp de cel puțin zece minute, fără a aplica unguente. În cazul electrocutării, victima se atinge numai după întreruperea curentului.',
      'Trusele sanitare sunt amplasate în fiecare autobază, în atelierele de reparații și în toate vehiculele. Responsabilul de sector verifică lunar termenele de valabilitate și completează conținutul lipsă pe baza necesarului transmis Serviciului SSM.',
    ],
  },
  {
    key: 'fisa-instruire-costache', title: 'Fișă de instruire individuală SSM - Mihai Costache', type: 'Fișă de instruire SSM', register: 'SSM', department: 'SSM', folder: 'Fișe de instruire',
    by: 'manager.ssm', direction: 'intern', issuer: 'Serviciul SSM', summary: 'Instruire la angajare și la locul de muncă pentru un conducător auto.', personalData: true,
    metadata: { angajat: 'Mihai Costache', tip_instruire: 'la angajare', data_instruire: '2026-03-02' },
    paragraphs: [
      'Numele și prenumele: Mihai Costache. Funcția: conducător auto, Autobaza Dacia. Data nașterii: 14 iunie 1988. Marca: 40217. Aptitudine medicală: apt, conform fișei emise de medicina muncii la 24 februarie 2026.',
      'Instruirea introductiv-generală a durat opt ore și a acoperit riscurile specifice transportului public, circulația în incintă și procedura de evacuare. Instruirea la locul de muncă a durat 16 ore, sub îndrumarea unui conducător auto cu experiență.',
      'Lucrătorul confirmă prin semnătură că a primit și a înțeles instrucțiunile IP-SSM-01 și IP-SSM-11. Următoarea instruire periodică este programată peste trei luni.',
    ],
  },
  {
    key: 'pv-stingatoare', title: 'Proces-verbal de verificare a stingătoarelor - Autobaza Dacia', type: 'Proces-verbal SSM', register: 'SSM', department: 'SSM', folder: 'Procese-verbale',
    by: 'manager.ssm', direction: 'intern', issuer: 'Serviciul SSM', summary: 'Verificarea semestrială a mijloacelor de stingere.', dueInDays: 5,
    metadata: { loc: 'Autobaza Dacia', data_verificare: '2026-10-14' },
    paragraphs: [
      'Comisia formată din inspectorul SSM și șeful de autobază a verificat la 14 octombrie 2026 toate stingătoarele din hală, magazie și birouri, precum și cele din 42 de autobuze aflate în incintă.',
      'Au fost găsite conforme 87 de stingătoare. Trei stingătoare cu pulbere din magazia de piese au depășit termenul de verificare și au fost retrase pentru reîncărcare la firma autorizată. Două vehicule aveau suportul stingătorului slăbit, remediat pe loc.',
      'Se dispune ca, în termen de cinci zile, șeful de autobază să confirme în scris înlocuirea stingătoarelor retrase. Inspectorul SSM va verifica din nou magazia la sfârșitul lunii.',
    ],
  },
  {
    key: 'pv-eveniment', title: 'Proces-verbal de cercetare a evenimentului din atelierul de boghiuri', type: 'Proces-verbal SSM', register: 'SSM', department: 'SSM', folder: 'Procese-verbale',
    by: 'manager.ssm', direction: 'intern', issuer: 'Serviciul SSM', summary: 'Accident ușor de muncă, cercetat de comisia internă.', personalData: true, favoriteBy: ['manager.ssm'],
    metadata: { loc: 'Atelier boghiuri', data_verificare: '2026-08-21' },
    paragraphs: [
      'La 19 august 2026, ora 10:40, lăcătușul Sorin Vasiliu, marca 31882, s-a lovit la mâna stângă în timpul demontării unui boghiu de tramvai. A primit îngrijiri la spital și a beneficiat de concediu medical de patru zile.',
      'Comisia a constatat că dispozitivul de ridicare era funcțional, însă piesa nu fusese asigurată cu al doilea cablu, așa cum cere fișa tehnologică. Lucrătorul purta echipamentul de protecție complet și avea instruirea periodică la zi.',
      'Măsuri stabilite: reinstruirea echipei din atelier, marcarea punctelor de prindere pe boghiu și verificarea prin sondaj a respectării fișei tehnologice de către șeful de atelier, timp de o lună.',
    ],
  },

  // Resurse umane -------------------------------------------------------------
  {
    key: 'cerere-co-rusu', title: 'Cerere de concediu de odihnă - Andreea Popovici', type: 'Cerere de concediu', register: 'RU', department: 'Resurse Umane', folder: 'Concedii',
    by: 'manager.hr', direction: 'intern', issuer: 'Andreea Popovici', recipient: 'Serviciul Resurse Umane', summary: 'Concediu de odihnă, 10 zile lucrătoare, noiembrie 2026.', dueInDays: 3, personalData: true,
    metadata: { angajat: 'Andreea Popovici', data_inceput: '2026-11-16', data_sfarsit: '2026-11-27', zile: '10' },
    paragraphs: [
      'Subsemnata Andreea Popovici, contabil în cadrul Serviciului Financiar, vă rog să îmi aprobați efectuarea a zece zile lucrătoare din concediul de odihnă aferent anului 2026, în perioada 16 - 27 noiembrie.',
      'Pe durata absenței, atribuțiile curente vor fi preluate de colega Raluca Sandu, cu care am stabilit predarea lucrărilor în curs. Închiderea de lună va fi finalizată înainte de plecare.',
      'Sold zile rămase după această cerere: șase. Vă mulțumesc.',
    ],
  },
  {
    key: 'cerere-co-costache', title: 'Solicitare zile de odihnă - Mihai Costache', type: 'Cerere de concediu', register: 'RU', department: 'Resurse Umane', folder: 'Concedii',
    by: 'registratura.demo', direction: 'intrat', issuer: 'Mihai Costache', recipient: 'Șef autobază', summary: 'Conducător auto, cinci zile în decembrie, cu acordul dispeceratului.', personalData: true,
    metadata: { angajat: 'Mihai Costache', data_inceput: '2026-12-07', data_sfarsit: '2026-12-11', zile: '5' },
    paragraphs: [
      'Domnule șef de autobază, sunt angajat ca șofer pe linia 28 și doresc să plec în perioada 7 - 11 decembrie, pentru o intervenție medicală programată a unui membru de familie.',
      'Am discutat cu dispeceratul care poate acoperi turele din graficul meu prin schimb cu un coleg din rezervă. Atașez acordul scris al acestuia, iar foaia colectivă de prezență va fi actualizată de pontator.',
    ],
  },
  {
    key: 'cim-grigore', title: 'Contract individual de muncă nr. 1187 - Teodor Grigoraș', type: 'Contract individual de muncă', register: 'RU', department: 'Resurse Umane', folder: 'Contracte de muncă',
    by: 'manager.hr', direction: 'intern', issuer: 'Serviciul Resurse Umane', recipient: 'Teodor Grigoraș', summary: 'Angajare pe perioadă nedeterminată, vatman.', personalData: true,
    metadata: { angajat: 'Teodor Grigoraș', functie_angajat: 'Vatman', data_angajare: '2026-09-01' },
    paragraphs: [
      'Între societate, în calitate de angajator, și domnul Teodor Grigoraș, CNP 1900507000000 (exemplu fictiv), domiciliat în Iași, în calitate de salariat, s-a încheiat prezentul contract individual de muncă, pe durată nedeterminată, cu începere de la 1 septembrie 2026.',
      'Salariatul ocupă funcția de vatman, cu normă întreagă de opt ore pe zi, în ture conform graficului, cu locul de muncă la Depoul Copou. Perioada de probă este de 90 de zile calendaristice. Salariul de bază lunar brut este stabilit prin actul adițional anexat.',
      'Concediul anual de odihnă este de 24 de zile lucrătoare. Drepturile și obligațiile părților sunt cele prevăzute de Codul muncii, de contractul colectiv de muncă aplicabil și de regulamentul intern, care i-au fost aduse la cunoștință la semnare.',
    ],
  },
  {
    key: 'decizie-transfer', title: 'Decizie de personal privind mutarea la Autobaza Nicolina - Ana Damian', type: 'Decizie de personal', register: 'RU', department: 'Resurse Umane', folder: 'Decizii de personal',
    by: 'manager.hr', direction: 'intern', issuer: 'Director General', recipient: 'Ana Damian', summary: 'Modificarea locului de muncă la cererea salariatei.', personalData: true,
    metadata: { angajat: 'Ana Damian', data_efect: '2026-11-01' },
    paragraphs: [
      'Având în vedere cererea doamnei Ana Damian, taxator-controlor, înregistrată în luna septembrie, și avizul favorabil al Serviciului Exploatare, directorul general decide modificarea locului de muncă de la Autobaza Dacia la Autobaza Nicolina, începând cu 1 noiembrie 2026.',
      'Celelalte clauze ale contractului individual de muncă rămân neschimbate. Serviciul Resurse Umane întocmește actul adițional și actualizează registrul general de evidență a salariaților.',
      'Prezenta decizie se comunică salariatei și șefilor celor două autobaze. Ea poate fi contestată la instanța competentă în termen de 30 de zile de la comunicare.',
    ],
  },
  {
    key: 'procedura-recrutare', title: 'Procedură de recrutare și selecție a personalului', type: 'Procedură operațională', register: 'RU', department: 'Resurse Umane', folder: 'Proceduri RU',
    by: 'manager.hr', direction: 'intern', issuer: 'Serviciul Resurse Umane', summary: 'Pașii de la solicitarea postului până la angajare.',
    metadata: { cod_procedura: 'PO-RU-01', revizie: '2' }, lines: ['Cod: PO-RU-01 · Revizia 2'],
    paragraphs: [
      'Compartimentul care are nevoie de personal completează referatul de post vacant, semnat de șeful direct și avizat financiar. Directorul general aprobă scoaterea postului la concurs.',
      'Anunțul se publică pe pagina societății și la agenția pentru ocuparea forței de muncă, cu cel puțin 15 zile înainte de probe. Dosarele se verifică de o comisie de trei membri, iar rezultatul selecției se afișează în două zile lucrătoare.',
      'Pentru conducătorii auto și vatmani, proba practică se desfășoară pe traseu, cu un instructor. Candidatul declarat admis prezintă fișa de aptitudine de la medicina muncii și avizul psihologic înainte de semnarea contractului.',
    ],
  },

  // Achiziții -----------------------------------------------------------------
  {
    key: 'referat-anvelope', title: 'Referat de necesitate pentru anvelope de iarnă', type: 'Referat de necesitate', register: 'ACH', department: 'Achiziții', folder: 'Referate',
    by: 'manager.achizitii', direction: 'intern', issuer: 'Serviciul Tehnic', recipient: 'Serviciul Achiziții', summary: 'Anvelope pentru autobuzele de 12 metri, sezonul de iarnă.', dueInDays: 6, favoriteBy: ['manager.achizitii'],
    metadata: { categorie_valoare: 'peste_prag', valoare_estimata: '486000', cod_cpv: '34352100-0' },
    paragraphs: [
      'Serviciul Tehnic solicită achiziționarea a 180 de anvelope 275/70 R22.5 pentru autobuzele de 12 metri. Uzura măsurată la ultima revizie arată că 64 de vehicule ajung sub limita de 4 mm până în luna ianuarie.',
      'Valoarea estimată este de 486.000 lei fără TVA, pe baza a trei oferte de preț consultate în octombrie. Livrarea trebuie să se facă eșalonat, cu primul lot înainte de 20 noiembrie, iar furnizorul trebuie să preia anvelopele uzate pentru reciclare.',
      'Suma este prevăzută în bugetul de investiții și reparații pentru exercițiul în curs. Fiind peste pragul intern, referatul se supune aprobării directorului general.',
    ],
  },
  {
    key: 'referat-birotica', title: 'Referat de necesitate pentru consumabile de birou', type: 'Referat de necesitate', register: 'ACH', department: 'Achiziții', folder: 'Referate',
    by: 'manager.achizitii', direction: 'intern', issuer: 'Registratură', recipient: 'Serviciul Achiziții', summary: 'Hârtie, bibliorafturi și tonere pentru trimestrul IV.',
    metadata: { categorie_valoare: 'sub_prag', valoare_estimata: '9200', cod_cpv: '30192000-1' },
    paragraphs: [
      'Registratura centralizează necesarul de papetărie al compartimentelor administrative: 400 de topuri de hârtie A4, 150 de bibliorafturi și 36 de cartușe de toner pentru imprimantele de rețea.',
      'Valoarea estimată este de 9.200 lei fără TVA și se încadrează sub pragul intern, așa că aprobarea revine șefului Serviciului Achiziții. Produsele se recepționează la magazia administrativă, iar distribuția pe birouri se face de către Registratură pe bază de semnătură.',
    ],
  },
  {
    key: 'referat-saboti', title: 'Referat de necesitate pentru saboți de frână tramvai', type: 'Referat de necesitate', register: 'ACH', department: 'Achiziții', folder: 'Referate',
    by: 'manager.achizitii', direction: 'intern', issuer: 'Serviciul Tehnic', recipient: 'Serviciul Achiziții', summary: 'Piese de schimb pentru sistemul de frânare al tramvaielor.',
    metadata: { categorie_valoare: 'peste_prag', valoare_estimata: '212500', cod_cpv: '34631000-9' },
    paragraphs: [
      'Atelierul de boghiuri semnalează scăderea stocului de saboți de frână sub nivelul minim de siguranță, în urma reviziilor planificate pe parcursul verii. Consumul mediu lunar este de 110 bucăți.',
      'Se propune cumpărarea a 850 de bucăți, suficiente pentru opt luni de exploatare, la o valoare estimată de 212.500 lei fără TVA. Piesele trebuie să fie însoțite de certificat de calitate și declarație de conformitate.',
      'Lipsa lor ar duce la imobilizarea tramvaielor în depou. Solicităm tratarea cu prioritate a acestei achiziții.',
    ],
  },
  {
    key: 'oferta-anvelope', title: 'Ofertă de preț pentru anvelope - Rulaj Sigur S.R.L.', type: 'Corespondență', register: 'RG', department: 'Achiziții', folder: 'Oferte',
    by: 'registratura.demo', direction: 'intrat', issuer: 'Rulaj Sigur S.R.L.', recipient: 'Serviciul Achiziții', summary: 'Răspuns la solicitarea de ofertă pentru anvelope.', linkTo: { key: 'referat-anvelope', kind: 'anexa_la' },
    metadata: { referinta: 'Oferta 771/2026' },
    paragraphs: [
      'Ca urmare a solicitării dumneavoastră, vă transmitem oferta noastră pentru anvelope de autobuz dimensiunea 275/70 R22.5, cu indice de sarcină potrivit transportului urban și marcaj M+S.',
      'Prețul unitar este de 2.610 lei fără TVA, cu livrare la sediul beneficiarului în 15 zile de la comandă. Garanția este de 36 de luni, iar colectarea anvelopelor uzate este inclusă în preț. Oferta rămâne valabilă 30 de zile.',
    ],
  },
  {
    key: 'contract-motorina', title: 'Contract de furnizare motorină nr. 92 - Carbotrans Moldova S.R.L.', type: 'Contract de achiziție', register: 'CTR', department: 'Achiziții', folder: 'Contracte',
    by: 'manager.achizitii', direction: 'iesit', issuer: 'Serviciul Achiziții', recipient: 'Carbotrans Moldova S.R.L.', summary: 'Furnizare motorină euro 6 pentru parcul de autobuze, 12 luni.', dueInDays: 45,
    metadata: { furnizor: 'Carbotrans Moldova S.R.L.', valoare: '7450000', data_expirare: '2027-03-31' },
    paragraphs: [
      'Obiectul contractului îl reprezintă furnizarea a 1.100.000 de litri de motorină, cu livrare în rezervoarele celor două autobaze, pe bază de comenzi ferme lansate cu 48 de ore înainte.',
      'Prețul se stabilește la data fiecărei livrări, pornind de la cotația de referință a rafinăriei, cu un discount fix de 0,12 lei pe litru. Plata se face în 30 de zile de la data facturii. Calitatea se dovedește prin buletin de analiză pentru fiecare cisternă.',
      'Pentru neîndeplinirea la termen, furnizorul datorează penalități de 0,1% pe zi din valoarea cantității nelivrate. Contractul intră în vigoare la 1 aprilie 2026 și este valabil 12 luni.',
    ],
  },
  {
    key: 'pv-receptie-baterii', title: 'Proces-verbal de recepție pentru baterii de tracțiune', type: 'Proces-verbal de recepție', register: 'ACH', department: 'Achiziții', folder: 'Recepții',
    by: 'manager.achizitii', direction: 'intern', issuer: 'Comisia de recepție', summary: 'Recepția cantitativă și calitativă a bateriilor de acumulatori.',
    metadata: { furnizor: 'Energo Baterii S.A.', numar_factura: 'EB-30418' },
    paragraphs: [
      'Comisia de recepție numită prin decizie a verificat, în magazia centrală, cele 24 de baterii de acumulatori livrate cu factura EB-30418 și avizul de însoțire aferent. Numărul de bucăți și seriile corespund comenzii.',
      'Tensiunea măsurată la bornele fiecărei baterii se încadrează în limitele din fișa tehnică, iar ambalajele nu prezintă deteriorări. Nu au fost constatate neconformități. Garanția de 24 de luni curge de la data prezentului proces-verbal.',
    ],
  },

  // Exploatare ----------------------------------------------------------------
  {
    key: RECLAMATII_KEY, title: 'Procedură de soluționare a reclamațiilor călătorilor', type: 'Procedură operațională', register: 'EXP', department: 'Exploatare', folder: 'Proceduri exploatare',
    by: 'manager.exploatare', direction: 'intern', issuer: 'Serviciul Exploatare', summary: 'Primirea, repartizarea și răspunsul la sesizările călătorilor.', favoriteBy: ['manager.exploatare', 'admin.demo'],
    metadata: { cod_procedura: 'PO-EXP-02', revizie: '1' }, lines: ['Cod: PO-EXP-02 · Revizia 1'],
    paragraphs: [
      'Reclamațiile călătorilor se primesc prin formularul de pe pagina societății, la casele de bilete, prin poștă sau prin dispecerat. Toate se înregistrează în aceeași zi la Registratură și primesc un număr unic.',
      'Dispecerul de serviciu repartizează sesizarea compartimentului responsabil: Exploatare pentru abateri de la orar și comportamentul personalului, Tehnic pentru starea vehiculelor, iar Financiar pentru problemele de taxare. Termenul de răspuns este de 30 de zile calendaristice.',
      'Când se confirmă abaterea unui angajat, șeful de autobază propune măsura potrivită, iar răspunsul către petent se semnează de șeful Serviciului Exploatare. Datele personale ale petentului se folosesc numai pentru soluționare și nu se transmit terților.',
      'Lunar, serviciul centralizează numărul de sesizări pe linii și pe categorii, iar concluziile se prezintă în ședința operativă, pentru a corecta cauzele care se repetă.',
    ],
  },
  {
    key: 'raport-exploatare', title: 'Raport lunar de exploatare pentru luna septembrie', type: 'Raport tehnic', register: 'EXP', department: 'Exploatare', folder: 'Rapoarte',
    by: 'manager.exploatare', direction: 'intern', issuer: 'Serviciul Exploatare', recipient: 'Director General', summary: 'Indicatori de regularitate, curse efectuate și anulate.',
    metadata: { vehicul: 'Tot parcul' },
    paragraphs: [
      'În luna septembrie au fost programate 61.240 de curse, dintre care 60.512 efectuate integral, ceea ce reprezintă un grad de realizare de 98,8%. Cele mai multe curse suspendate au fost pe liniile de tramvai 3 și 7, din cauza lucrărilor la cale.',
      'Punctualitatea medie la capete de linie a fost de 91%. Abaterile mai mari de cinci minute s-au concentrat în intervalul 7:30 - 9:00, pe arterele cu trafic aglomerat. S-a propus reglarea graficului pe două linii de autobuz începând cu luna următoare.',
      'Parcul activ mediu zilnic a fost de 148 de autobuze și 52 de tramvaie. Au fost înregistrate 38 de sesizări de la călători, dintre care 9 întemeiate.',
    ],
  },
  {
    key: 'adresa-modificare-traseu', title: 'Adresă privind restricțiile de circulație pe Bulevardul Independenței', type: 'Corespondență', register: 'RG', department: 'Exploatare', folder: 'Corespondență',
    by: 'registratura.demo', direction: 'intrat', issuer: 'Serviciul Circulație Rutieră (exemplu)', recipient: 'Serviciul Exploatare', summary: 'Închidere temporară de bandă pentru lucrări edilitare.', dueInDays: 2,
    metadata: { referinta: 'Adresa 5521/2026' },
    paragraphs: [
      'Vă informăm că, în intervalul 3 - 14 noiembrie, o bandă de circulație de pe bulevard va fi închisă pentru lucrări la rețeaua de apă, pe sensul către Piața Unirii, în fiecare zi între orele 9:00 și 16:00.',
      'Vă rugăm să ne comunicați, în cel mult cinci zile, modificările de traseu și stațiile afectate, pentru a le corela cu semnalizarea rutieră temporară.',
    ],
  },
  {
    key: 'raspuns-modificare-traseu', title: 'Răspuns privind devierea liniilor pe durata lucrărilor edilitare', type: 'Corespondență', register: 'RG', department: 'Exploatare', folder: 'Corespondență',
    by: 'manager.exploatare', direction: 'iesit', issuer: 'Serviciul Exploatare', recipient: 'Serviciul Circulație Rutieră (exemplu)', summary: 'Liniile afectate și stațiile mutate temporar.', linkTo: { key: 'adresa-modificare-traseu', kind: 'raspuns_la' },
    metadata: { referinta: 'Răspuns la Adresa 5521/2026' },
    paragraphs: [
      'În urma adresei dumneavoastră, vă comunicăm că liniile de autobuz 28 și 46 vor circula pe traseu deviat prin strada Sărărie în intervalul anunțat, iar stația „Independenței” se mută provizoriu cu 150 de metri în aval.',
      'Liniile de tramvai nu sunt afectate. Călătorii vor fi anunțați prin afișe în stații, pe pagina societății și prin mesaje în vehicule, cu trei zile înainte de începerea lucrărilor.',
    ],
  },

  // Tehnic --------------------------------------------------------------------
  {
    key: 'procedura-verificare-r2', title: 'Procedură de verificare zilnică a autobuzului la ieșirea pe traseu', type: 'Procedură operațională', register: 'TEH', department: 'Tehnic', folder: 'Proceduri tehnice',
    by: 'manager.tehnic', direction: 'intern', issuer: 'Serviciul Tehnic', summary: 'Controlul zilnic al vehiculului de către conducătorul auto, revizia 2.',
    metadata: { cod_procedura: 'PO-TEH-03', revizie: '2' }, lines: ['Cod: PO-TEH-03'],
    paragraphs: verificareZilnica('2', 'Foile de parcurs se păstrează la autobază și se verifică prin sondaj de către inspectorul de siguranța circulației.'),
  },
  {
    // Aproape identic cu cel de sus, ca să apară ca posibil duplicat după conținut.
    key: 'procedura-verificare-r3', title: 'Procedură privind verificarea zilnică a autobuzului înainte de plecare', type: 'Procedură operațională', register: 'TEH', department: 'Tehnic', folder: 'Proceduri tehnice',
    by: 'manager.tehnic', direction: 'intern', issuer: 'Serviciul Tehnic', summary: 'Copie reeditată a procedurii, cu o precizare nouă.',
    metadata: { cod_procedura: 'PO-TEH-03', revizie: '3' }, lines: ['Cod: PO-TEH-03'],
    paragraphs: verificareZilnica('3', 'Foile de parcurs se păstrează la autobază și se verifică lunar prin sondaj de către inspectorul de siguranța circulației.'),
  },
  {
    key: 'raport-defect-tramvai', title: 'Raport tehnic privind defectarea convertizorului de la tramvaiul 214', type: 'Raport tehnic', register: 'TEH', department: 'Tehnic', folder: 'Rapoarte tehnice',
    by: 'manager.tehnic', direction: 'intern', issuer: 'Atelier electric', recipient: 'Serviciul Tehnic', summary: 'Analiza cauzei defectului și estimarea reparației.',
    metadata: { vehicul: 'Tramvai 214' },
    paragraphs: [
      'La 6 octombrie, tramvaiul cu numărul de parc 214 a rămas fără alimentare auxiliară pe linia 3. Vehiculul a fost remorcat în depou, fără evenimente pentru călători.',
      'Măsurătorile din atelierul electric au găsit modulul IGBT al convertizorului străpuns, cel mai probabil din cauza supraîncălzirii provocate de ventilatorul blocat. Filtrele de aer erau colmatate, deși revizia fusese făcută la termen.',
      'Se recomandă înlocuirea modulului și a ventilatorului, plus reducerea intervalului de curățare a filtrelor de la 60 la 30 de zile, pentru întregul lot de tramvaie modernizate. Durata estimată a reparației este de șase zile.',
    ],
  },
  {
    key: 'raport-revizie-autobuze', title: 'Raport privind revizia tehnică periodică a autobuzelor electrice', type: 'Raport tehnic', register: 'TEH', department: 'Tehnic', folder: 'Rapoarte tehnice',
    by: 'manager.tehnic', direction: 'intern', issuer: 'Serviciul Tehnic', summary: 'Rezultatele reviziei de 40.000 km la autobuzele electrice.', favoriteBy: ['manager.tehnic'],
    metadata: { vehicul: 'Autobuze electrice 601-612' },
    paragraphs: [
      'Au intrat în revizia de 40.000 km douăsprezece autobuze electrice, între 2 și 25 septembrie. Toate au fost reconfirmate la inspecția tehnică periodică, fără defecte majore.',
      'S-au observat o uzură neuniformă a plăcuțelor de frână pe puntea din față la patru vehicule și un grad de degradare a bateriilor de 3% față de valoarea nominală, sub limita acoperită de garanție.',
      'Se propune actualizarea softului de recuperare a energiei la frânare, în colaborare cu producătorul, și monitorizarea lunară a stării bateriilor până la următoarea revizie.',
    ],
  },

  // Conducere, IT, Juridic ----------------------------------------------------
  {
    key: 'decizie-comisie-receptie', title: 'Decizia nr. 214 privind numirea comisiei permanente de recepție', type: 'Decizie a directorului general', register: 'DEC', department: 'Conducere', folder: 'Decizii',
    by: 'director.general', direction: 'intern', issuer: 'Director General', summary: 'Componența comisiei de recepție a bunurilor și serviciilor.', favoriteBy: ['director.general'],
    metadata: { numar_decizie: '214' },
    paragraphs: [
      'Directorul general al societății, în temeiul atribuțiilor conferite prin actul constitutiv, decide constituirea comisiei permanente de recepție a bunurilor, serviciilor și lucrărilor achiziționate.',
      'Comisia este formată din câte un reprezentant al Serviciului Achiziții, Serviciului Tehnic și compartimentului financiar. Președinția revine șefului Serviciului Tehnic. Pentru recepțiile cu specific aparte, comisia poate solicita sprijinul specialiștilor din alte compartimente.',
      'Procesele-verbale de recepție se înregistrează în ziua semnării și se transmit în copie compartimentului financiar. Prezenta decizie intră în vigoare la data emiterii și abrogă orice dispoziție contrară.',
    ],
  },
  {
    key: 'politica-parole', title: 'Regulament privind utilizarea sistemelor informatice', type: 'Procedură operațională', register: 'RG', department: 'IT', folder: 'Regulamente IT',
    by: 'admin.demo', direction: 'intern', issuer: 'Compartimentul IT', summary: 'Conturi, parole, autentificare în doi pași și copii de siguranță.',
    metadata: { cod_procedura: 'REG-IT-01', revizie: '1' },
    paragraphs: [
      'Fiecare salariat folosește un cont individual pentru accesul la aplicațiile societății. Parolele au cel puțin zece caractere, se schimbă la 180 de zile și nu se comunică nimănui, nici personalului IT.',
      'Accesul din afara rețelei interne este permis numai cu autentificare în doi pași, printr-o aplicație de pe telefonul de serviciu. După cinci încercări greșite, contul se blochează automat pentru 15 minute.',
      'Documentele de lucru se păstrează în aplicația de management al documentelor, nu pe stații de lucru sau stick-uri USB. Incidentele de securitate se anunță imediat Compartimentului IT.',
    ],
  },
  {
    key: 'nota-juridica', title: 'Notă juridică privind prelucrarea imaginilor din camerele video de bord', type: 'Corespondență', register: 'RG', department: 'Juridic', folder: 'Avize juridice',
    by: 'admin.demo', direction: 'intern', issuer: 'Compartimentul Juridic', recipient: 'Director General', summary: 'Temeiul legal, informarea călătorilor și durata de stocare.',
    metadata: { referinta: 'Notă 88/2026' },
    paragraphs: [
      'Instalarea camerelor video la bordul vehiculelor constituie o prelucrare de date cu caracter personal. Temeiul poate fi interesul legitim al societății de a proteja călătorii și bunurile, cu condiția efectuării unei evaluări de impact.',
      'Călătorii trebuie informați prin pictograme vizibile și printr-o notă disponibilă pe pagina societății. Imaginile se păstrează cel mult 30 de zile, iar accesul se acordă unui număr restrâns de persoane desemnate, cu evidența fiecărei vizualizări.',
      'Recomandăm actualizarea registrului activităților de prelucrare și a contractului cu furnizorul de echipamente înainte de punerea în funcțiune.',
    ],
  },

  // Documente vechi, deja arhivate --------------------------------------------
  {
    key: 'arhiva-corespondenta-2021', title: 'Solicitare de informații privind abonamentele pentru elevi', type: 'Corespondență', register: 'RG', department: 'Registratură', folder: 'Corespondență generală',
    by: 'registratura.demo', direction: 'intrat', issuer: 'Asociația Părinților (exemplu)', recipient: 'Serviciul Exploatare', summary: 'Adresă din 2021, termen de păstrare depășit.', archive: { mode: 'expired', year: 2021 },
    metadata: { referinta: 'Adresa 312/2021' },
    paragraphs: [
      'Vă rugăm să ne comunicați condițiile în care elevii din ciclul gimnazial pot obține abonamente lunare la tarif redus și documentele necesare la casele de bilete.',
      'Totodată, solicităm lista punctelor de vânzare deschise în afara programului obișnuit, în perioada de început a anului școlar. Răspunsul poate fi transmis pe adresa de corespondență a asociației.',
    ],
  },
  {
    key: 'arhiva-cerere-2019', title: 'Cerere de concediu de odihnă din anul 2019 - Daniela Hobincu', type: 'Cerere de concediu', register: 'RU', department: 'Resurse Umane', folder: 'Concedii',
    by: 'manager.hr', direction: 'intern', issuer: 'Daniela Hobincu', summary: 'Cerere veche, termen de păstrare depășit.', personalData: true, archive: { mode: 'expired', year: 2019 },
    metadata: { angajat: 'Daniela Hobincu', data_inceput: '2019-07-15', data_sfarsit: '2019-07-26', zile: '10' },
    paragraphs: [
      'Am rugămintea să aprobați programarea concediului meu anual de vară, între 15 și 26 iulie 2019, conform planificării stabilite la nivelul biroului de salarizare.',
      'Lucrările urgente au fost predate, iar statele de plată din iulie vor fi verificate de colega desemnată înainte de plecarea mea.',
    ],
  },
  {
    key: 'arhiva-referat-2019', title: 'Referat de necesitate pentru tipărirea biletelor de călătorie în 2019', type: 'Referat de necesitate', register: 'ACH', department: 'Achiziții', folder: 'Referate',
    by: 'manager.achizitii', direction: 'intern', issuer: 'Serviciul Exploatare', summary: 'Referat din 2019, termen de păstrare depășit.', archive: { mode: 'expired', year: 2019 },
    metadata: { categorie_valoare: 'sub_prag', valoare_estimata: '38000', cod_cpv: '22459000-2' },
    paragraphs: [
      'Pentru semestrul al doilea din 2019 este nevoie de 1.500.000 de bilete cu două călătorii, cu elemente de siguranță împotriva falsificării, potrivit modelului actual aprobat de consiliul de administrație.',
      'Stocul existent acoperă consumul doar până în luna septembrie. Valoarea estimată a tipăririi este de 38.000 lei fără TVA.',
    ],
  },
  {
    key: 'arhiva-raport-2020', title: 'Raport tehnic privind modernizarea stațiilor de redresare în 2020', type: 'Raport tehnic', register: 'TEH', department: 'Tehnic', folder: 'Rapoarte tehnice',
    by: 'manager.tehnic', direction: 'intern', issuer: 'Serviciul Tehnic', summary: 'Raport din 2020, termen de păstrare depășit.', archive: { mode: 'expired', year: 2020 },
    metadata: { vehicul: 'Substații de tracțiune' },
    paragraphs: [
      'Lucrările de modernizare a celor două stații de redresare s-au încheiat în decembrie 2020, cu înlocuirea celulelor de medie tensiune și a redresoarelor cu diode de generație veche.',
      'Consumul propriu al stațiilor a scăzut cu aproximativ 11%, iar telecomanda din dispeceratul energetic funcționează fără incidente de la punerea în funcțiune. Documentația de execuție a fost predată beneficiarului.',
    ],
  },
  {
    key: 'arhiva-contract-curatenie', title: 'Contract de servicii de curățenie în autobaze - Lumina Prest S.R.L.', type: 'Contract de achiziție', register: 'CTR', department: 'Achiziții', folder: 'Contracte',
    by: 'manager.achizitii', direction: 'iesit', issuer: 'Serviciul Achiziții', recipient: 'Lumina Prest S.R.L.', summary: 'Contract încheiat, arhivat cu termen în desfășurare.', archive: { mode: 'current' },
    metadata: { furnizor: 'Lumina Prest S.R.L.', valoare: '184000', data_expirare: '2026-06-30' },
    paragraphs: [
      'Prestatorul asigură curățenia zilnică a spațiilor administrative și a vestiarelor din cele două autobaze, de luni până sâmbătă, cu materiale proprii, conform graficului anexat.',
      'Calitatea serviciilor se confirmă lunar de responsabilul de contract. Pentru deficiențe neremediate în 24 de ore se aplică o penalitate de 2% din valoarea lunară a contractului, care a fost îndeplinit integral la 30 iunie 2026.',
    ],
  },
  {
    key: 'arhiva-decizie-program', title: 'Decizia nr. 41 privind organigrama și regulamentul de organizare', type: 'Decizie a directorului general', register: 'DEC', department: 'Conducere', folder: 'Decizii',
    by: 'director.general', direction: 'intern', issuer: 'Director General', summary: 'Document cu păstrare permanentă.', archive: { mode: 'current' },
    metadata: { numar_decizie: '41' },
    paragraphs: [
      'Se aprobă organigrama societății și regulamentul de organizare și funcționare, în forma din anexele care fac parte integrantă din prezenta decizie.',
      'Șefii de compartimente vor actualiza fișele de post în termen de 60 de zile și le vor transmite Serviciului Resurse Umane. Documentul se păstrează permanent, fiind act constitutiv al structurii interne.',
    ],
  },
];

/** Textul din `samples/scan-instructiune-ssm.pdf`. Cuvântul „hamul” nu apare în niciun alt document, deci arată rezultatul OCR. */
export const SCANNED_SAMPLE = {
  title: 'Instrucțiune proprie SSM nr. 15 privind lucrul la înălțime în depoul de tramvaie',
  lines: ['Cod: IP-SSM-15 · Ediția 1 · Exemplar scanat'],
  paragraphs: [
    'Lucrătorii care urcă pe acoperișul tramvaiului pentru intervenții la pantograf folosesc obligatoriu hamul de siguranță, ancorat la linia de viață de pe platforma de acces.',
    'Înainte de urcare, șeful de echipă verifică scoaterea de sub tensiune, starea scărilor și existența căștii de protecție. Se interzice lucrul singur, pe timp de furtună sau pe suprafețe umede.',
    'Sculele se țin în geantă închisă, pentru a nu cădea peste persoanele aflate dedesubt. Zona de sub platformă se îngrădește și se semnalizează pe toată durata lucrării.',
    'Încălcarea acestor reguli atrage răspunderea disciplinară. Instruirea se repetă la fiecare șase luni și se consemnează în fișa individuală de instruire.',
  ],
};
