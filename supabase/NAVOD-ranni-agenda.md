# Ranní agenda a připomínky e-mailem – nastavení

Funkce `daily-agenda` běží v Supabase. Každých 5 minut ji spustí plánovač:
- ranní agendu odešle jen v nastavenou hodinu (výchozí 6:00 pražského času),
- u úkolů, které mají v kalendáři zapnutou obálku ✉, pošle připomínku 10 minut před začátkem.

Soubory:
- `supabase/functions/daily-agenda/index.ts` – serverová funkce
- `supabase/functions/_shared/dailyAgenda.ts` – sestavení agendy (stejné jako náhled „Email“ v aplikaci)
- `supabase/functions/.env` – tajné hodnoty (zůstávají jen u tebe)
- `supabase/daily-agenda-cron.sql` – plánovač

## A. Resend (jednou)
1. Zaregistruj se na https://resend.com e-mailem, na který chceš agendu dostávat.
2. Vlevo **API Keys** → **Create API Key** → název třeba `plantplan`, oprávnění **Sending access** → **Add**.
3. Klíč (začíná `re_`) si hned zkopíruj – zobrazí se jen jednou.

## B. Vyplň `supabase/functions/.env`
1. `RESEND_API_KEY=` → vlož klíč z kroku A3.
2. `AGENDA_EMAIL_TO=` → e-mail z kroku A1.
   - Pokud se do PlantPlanu přihlašuješ **jiným** e-mailem, přidej řádek
     `AGENDA_USER_ID=...` (Supabase → Authentication → Users → u svého účtu zkopíruj **UID**).
3. `APP_URL=` → adresa online PlantPlanu (nepovinné, odkaz v patičce e-mailu).
4. Ulož. `CRON_SECRET` už je vyplněný – neměň ho.

## C. Nahrání funkce (terminál ve složce PlantPlan)
1. `npx supabase login` → otevře se prohlížeč, potvrď přihlášení.
2. `npx supabase functions deploy daily-agenda --project-ref hfztgzmjtgatjxgzskzy --no-verify-jwt`
3. `npx supabase secrets set --env-file supabase/functions/.env --project-ref hfztgzmjtgatjxgzskzy`

## D. Zkušební e-mail hned teď (PowerShell ve složce PlantPlan)
```powershell
$s = (Select-String -Path supabase\functions\.env -Pattern '^CRON_SECRET=(.*)').Matches[0].Groups[1].Value; Invoke-RestMethod -Method Post -Uri "https://hfztgzmjtgatjxgzskzy.supabase.co/functions/v1/daily-agenda?force=1" -Headers @{ "x-cron-secret" = $s }
```
Odpověď se seznamem v `sent` (předmět agendy) = odesláno. Zkontroluj schránku i **spam** (první e-mail označ „Není spam“).

## E. Zapnutí ranního odesílání
1. Supabase → **SQL Editor** → **New query**.
2. Vlož celý obsah `supabase/daily-agenda-cron.sql` → **Run**.

Hotovo – od zítřka přijde agenda v 6:00 a připomínky chodí 10 minut před úkoly s obálkou.

## Přechod z hodinového plánovače na 5minutový (pokud už ranní agendu máš)
1. Nahraj novou verzi funkce – krok C2 (když tě vyzve, nejdřív krok C1).
2. V SQL Editoru znovu spusť celý `supabase/daily-agenda-cron.sql` (krok E) – přepíše původní plánovač.

## Změny později
- Jiná hodina: uprav `AGENDA_HOUR` v `.env` a zopakuj krok C3.
- Úprava vzhledu e-mailu: po změně kódu zopakuj krok C2.
- Úplné vypnutí: v SQL Editoru spusť `select cron.unschedule('daily-agenda');`
