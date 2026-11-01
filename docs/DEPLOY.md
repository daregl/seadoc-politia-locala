# Instalare

## Pe acest server (fără Docker)

`scripts/serve.sh` pornește baza de date și aplicația dacă nu rulează și se poate rula oricând. Pentru pornire după restart, repornire la cădere și backup zilnic, adăugați cu `crontab -e`:

```
@reboot /home/darasm/CTP/scripts/serve.sh
*/5 * * * * /home/darasm/CTP/scripts/serve.sh
30 2 * * * /home/darasm/CTP/scripts/backup.sh >> /home/darasm/CTP/.data/backup.log 2>&1
```

## Backup și restaurare

Backup-ul stă în `.data/backups`, pe același disc, și nu protejează la pierderea serverului. Pentru cerința RPO/RTO, copiați-l în altă locație cu `SEADOC_BACKUP_DIR` sau cu un transfer zilnic. Cheia `STORAGE_KEY` din `.env` nu intră în backup: păstrați-o separat, fără ea fișierele nu se pot citi.

Restaurarea creează o bază și un director noi și verifică fiecare fișier și lanțul de audit:

```bash
scripts/restore.sh .data/backups/<data> seadoc_restaurat /cale/fisiere-noi
```

Pentru a folosi copia restaurată, schimbați `DATABASE_URL` și `STORAGE_DIR` în `.env` și reporniți aplicația.

## HTTPS

Aplicația nu servește TLS direct: pune în față un proxy, pe un domeniu cu certificat. Apoi, în `.env`:

```
HOST=127.0.0.1
COOKIE_SECURE=true
TRUST_PROXY=1
```

`TRUST_PROXY=1` e necesar: fără el, aplicația vede adresa proxy-ului și regula MFA de la distanță nu se mai aplică corect. Exemplu nginx:

```nginx
server {
  listen 443 ssl;
  server_name seadoc.exemplu.ro;
  ssl_certificate     /etc/letsencrypt/live/seadoc.exemplu.ro/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/seadoc.exemplu.ro/privkey.pem;
  client_max_body_size 60m;
  location / {
    proxy_pass http://127.0.0.1:4100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

## Docker Compose

`docker-compose.yml` definește aplicația și PostgreSQL 16. **Nu a fost rulat**: serverul de dezvoltare nu are Docker. Testați-l pe serverul de livrare înainte de a vă baza pe el.
