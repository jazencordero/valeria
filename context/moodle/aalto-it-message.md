Send to: servicedesk@aalto.fi (found on https://www.aalto.fi/en/student-guide/students-it-services). Cc: mycourses@aalto.fi, listed as the "MyCourses helpdesk" on https://wiki.aalto.fi/spaces/OPIT/pages/107200537/MyCourses+Service+Description
Subject: Is a student's own study app on the MyCourses mobile web service OK?

---

Hello,

I'm Jazen. I am building Ready, a small study helper. Right now one Aalto student uses it. It shows her deadlines and course material in one place, plans what to study next, and helps her hand in work. Before more people use it, I want to check that it is acceptable to you.

**How she connects.** She scans the QR code from her own MyCourses profile. That gives the same mobile web-service key the official Moodle app gets (`tool_mobile_get_tokens_for_qr_login`). Ready never asks for, sees or stores her Aalto password.

**Calls used.**
- Read: `core_webservice_get_site_info`, `core_enrol_get_users_courses`, `mod_assign_get_assignments`, `mod_assign_get_submission_status`, `core_course_get_contents`, `gradereport_user_get_grade_items`, `core_calendar_get_action_events_by_timesort`, `mod_quiz_get_quizzes_by_courses`, plus file downloads through `/webservice/pluginfile.php`.
- Write, for hand-in only: `/webservice/upload.php`, `mod_assign_save_submission`, `mod_assign_submit_for_grading`.
- Not used: `core_files_upload` (not on her key), `core_calendar_get_calendar_export_token` and `message_popup_get_popup_notifications` (on her key, but we don't call them).

**Hand-in.** It happens only when she taps "Hand in" herself, after a review screen showing the file and the assignment. Nothing runs in the background, and no scheduled job can hand in for her. We have not yet tried a real hand-in.

**Her key.** It is stored on our server, encrypted (AES-256-GCM), and never written to logs. "Disconnect" deletes the key. "Delete everything" deletes her account and all her data.

**Load.** We only read when she opens the app, and not again within 10 minutes. At most 2 requests run at once, with 150 ms between them. There is a cap of 2,000 requests a day. We back off when the server returns 429 or 503. Requests are labelled `User-Agent: Ready/0.1 (student study tool)`.

**Course material and AI.** By default, nothing from a course goes to an AI model. Material is shared only for courses she has marked as allowing AI, based on the course's own rules. The models are hosted by outside providers on free tiers.

My questions:
1. Is this acceptable for one student now?
2. Would it be acceptable later for a small group of her classmates?
3. Is there a contact for integrations like this one?

I'll gladly change anything you'd like done differently.

Best regards,
Jazen

---

Hei,

Olen Jazen. Rakennan Ready-nimistä pientä opiskelun apuvälinettä. Tällä hetkellä sitä käyttää yksi Aallon opiskelija. Se näyttää hänen määräaikansa ja kurssimateriaalinsa yhdessä paikassa, suunnittelee mitä opiskella seuraavaksi ja auttaa palautuksissa. Ennen kuin sitä käyttää useampi ihminen, haluan varmistaa, että tämä sopii teille.

**Miten hän yhdistää.** Hän skannaa QR-koodin omasta MyCourses-profiilistaan. Siitä saadaan sama mobiilin verkkopalvelun avain, jonka virallinen Moodle-sovellus saa (`tool_mobile_get_tokens_for_qr_login`). Ready ei koskaan pyydä, näe eikä tallenna hänen Aalto-salasanaansa.

**Käytetyt kutsut.**
- Luku: `core_webservice_get_site_info`, `core_enrol_get_users_courses`, `mod_assign_get_assignments`, `mod_assign_get_submission_status`, `core_course_get_contents`, `gradereport_user_get_grade_items`, `core_calendar_get_action_events_by_timesort`, `mod_quiz_get_quizzes_by_courses` sekä tiedostojen lataus osoitteen `/webservice/pluginfile.php` kautta.
- Kirjoitus, vain palautukseen: `/webservice/upload.php`, `mod_assign_save_submission`, `mod_assign_submit_for_grading`.
- Ei käytössä: `core_files_upload` (ei hänen avaimellaan), `core_calendar_get_calendar_export_token` ja `message_popup_get_popup_notifications` (sallittu avaimella, mutta emme kutsu niitä).

**Palautus.** Se tapahtuu vain, kun hän itse painaa "Palauta" tarkistusnäkymän jälkeen, jossa näkyvät tiedosto ja tehtävä. Mitään ei ajeta taustalla, eikä mikään ajastettu työ voi palauttaa hänen puolestaan. Oikeaa palautusta emme ole vielä kokeilleet.

**Hänen avaimensa.** Avain on tallennettu palvelimellemme salattuna (AES-256-GCM), eikä sitä kirjoiteta lokeihin. "Katkaise yhteys" poistaa avaimen. "Poista kaikki" poistaa hänen tilinsä ja kaikki hänen tietonsa.

**Kuormitus.** Luemme tietoja vain, kun hän avaa sovelluksen, emmekä uudelleen 10 minuutin sisällä. Kerrallaan on käynnissä enintään 2 pyyntöä, ja niiden välillä on 150 ms. Päiväraja on 2 000 pyyntöä. Kun palvelin vastaa 429 tai 503, pidämme taukoa. Pyynnöissä on tunniste `User-Agent: Ready/0.1 (student study tool)`.

**Kurssimateriaali ja tekoäly.** Oletuksena kurssilta ei lähetetä mitään tekoälymallille. Materiaalia jaetaan vain kursseilta, jotka hän on merkinnyt tekoälyn sallituiksi kurssin omien sääntöjen perusteella. Mallit ovat ulkopuolisten palveluntarjoajien ilmaisversioita.

Kysymykseni:
1. Sopiiko tämä yhdelle opiskelijalle nyt?
2. Sopisiko se myöhemmin pienelle ryhmälle hänen kurssikavereitaan?
3. Onko teillä yhteyshenkilöä tällaisille integraatioille?

Muutan mielelläni mitä tahansa, minkä haluaisitte tehtävän toisin.

Ystävällisin terveisin,
Jazen
