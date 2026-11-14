# What Aalto and MyCourses say about tools like Ready

Ticket M0-13. Read on 2026-11-14. **Not legal advice.** Anything marked unclear goes into the message to Aalto IT (M0-10).

The five points:

- **(a)** A student letting a third-party tool sign in as her
- **(b)** Automated access or scraping
- **(c)** Sharing a personal key or password
- **(d)** Sending teachers' material to AI services
- **(e)** AI-written coursework

Quotes: at most one short sentence per point across the whole file. Everything else is a summary in our own words.

---

## 1. IT policies and guidelines (index page)

- URL: https://www.aalto.fi/en/services/it-policies-and-guidelines
- Read: 2026-11-14
- What it says: the old "Policy of information systems usage" is **no longer in force**. Acceptable use now sits in binding instruction **A8**, and access rights in **A9** (both linked as PDFs). The page also warns that it is itself out of date for security documents, and that they have moved to the Cyber Security and ISMS hubs.
- Bears on: tells us which documents count (A8, A9). Nothing on a to e directly.

## 2. A8 Asset Management, binding instruction, v1.0 (holds the acceptable-use rules)

- URL: https://www.aalto.fi/sites/default/files/2021-01/A8%20Suojattavan%20omaisuuden%20hallinta%20versio%201.0_en%20.pdf
- Read: 2026-11-14. Effective 28 Oct 2020. Section 4.2.1.
- (a) In its list of rules, a user may not give their own login to another party. Quote: "a user's own login may not be given to another party."
- (b) There is no rule that names scripts, APIs or scraping. The closest rules: no unnecessary strain on the system; no breaching of systems or services; no getting data from a system without authorisation. Services visible beyond your own machine need authorisation from the person in charge. Commercial use that promotes anything other than the university is forbidden unless authorised.
- (c) Covered by the same login rule as (a). See A9 below for passwords.
- (d) Course material such as lecture slides does not have to be returned or deleted after studies. So students may keep it. Nothing here says they may pass it on.
- (e) Nothing.
- Note: the newer ISMS hub page for A8 (https://www.aalto.fi/en/information-security-management-system-isms/a8-asset-management) returned **403 / needs Aalto login**. We could not check whether a newer version than 1.0 exists.

## 3. A9 Access Control, binding instruction, v1.0

- URL: https://www.aalto.fi/sites/default/files/2021-12/A9%20P%C3%A4%C3%A4synhallinta%20versio%201.0_EN_0.pdf
- Read: 2026-11-14. In force from 1 Oct 2020. Sections 1.5, 2.1, 2.4.1, 3a, 6.1.
- (a) Access rights are personal and tied to one person's username, so that actions can be traced to that person (2.1). Sharing a username is allowed only in exceptional cases on justifiable grounds, decided by the system owner, and never for processing personal data (2.4.1).
- (b) Nothing about automation as such.
- (c) Usernames and passwords are personal and confidential and may not be disclosed to anyone. The user is responsible for everything done with them. Quote (6.1): "Usernames and passwords are personal and confidential." The user must make sure nobody else knows their password (1.5). Storing passwords in plain text is prohibited (1.5). On getting access, a person commits in writing to keep their username and password secret (3a). If they suspect someone else has them, they must tell the security team at once (6.2). **Not mentioned anywhere:** app tokens or web-service keys (such as the Moodle mobile-app key) as distinct from passwords.
- (d), (e) Nothing.

## 4. Policy of information systems usage (old, 2010, reviewed 2012), for context only

- URL: https://www.aalto.fi/sites/default/files/2018-07/information_systems_usage_policy_web_0.pdf
- Read: 2026-11-14. **No longer in force** according to document 1. Listed only because it shows the older wording.
- (a)/(c) Personal accounts must not be disclosed to anybody. Using another person's account is prohibited. The account holder carries financial and legal responsibility for harm caused through the account.
- (b) It said not to use parts or features of a system that are not clearly meant for general use, and not to place unnecessary strain on system resources.
- (d), (e) Nothing.

## 5. Policy of sanctions for IT offences

- URL: https://www.aalto.fi/sites/default/files/2018-07/policy_of_sanctions_aalto_web_0.pdf (linked from document 1)
- Read: 2026-11-14. **Could not read it.** A direct download returned an HTML page instead of the PDF, and we did not retry through another route. A8 and A9 both point to it for the consequences of breaking the rules.

## 6. Aalto's user IDs and authorization

- URL: https://www.aalto.fi/en/services/aaltos-user-ids-and-authorization
- Read: 2026-11-14 (page updated 15.10.2026).
- Bears on: nothing directly. It says the Aalto ID is used to access Aalto's IT services and links to MFA instructions. There is no wording on sharing.

## 7. MyCourses: site policies on mycourses.aalto.fi

- URL: https://mycourses.aalto.fi/admin/tool/policy/viewall.php
- Read: 2026-11-14.
- Bears on: the Moodle policy list says there are no policies with an active version. **MyCourses publishes no terms of use of its own** that we could find. Aalto's general rules (A8, A9) and the course's own rules apply instead.

## 8. MyCourses Service Description (Aalto wiki)

- URL: https://wiki.aalto.fi/spaces/OPIT/pages/107200537/MyCourses+Service+Description
- Read: 2026-11-14 (no date shown).
- Bears on: login runs through Aalto's single sign-on. Course spaces are open to guests by default. Interaction such as assignments and discussions stays between course members. Nothing on the mobile app, web-service tokens, automated access or third-party tools. Turnitin is the only external tool it mentions.

## 9. MyCourses instructions for students (Aalto wiki)

- URL: https://wiki.aalto.fi/spaces/OPIT/pages/107201661/MyCourses+instructions+for+students
- Read: 2026-11-14 (no date shown).
- Bears on: always log in with your Aalto account. Course material is gone once the course space is removed (after 2 to 3 years). Nothing on apps, third-party tools, automation or AI.

## 10. Moodle Mobile App (Aalto wiki)

- URL: https://wiki.aalto.fi/display/OPIT/Moodle+Mobile+App
- Read: 2026-11-14 (looks last edited around 2017).
- Bears on: Aalto tells users to install the **official Moodle app**, but this guide is for **Aalto OpenLearning** (openlearning.aalto.fi), **not MyCourses**. We found no Aalto page that says whether the Moodle app, and so its key/QR flow, is supported or allowed for MyCourses.

## 11. Lecture recording policy (Aalto wiki)

- URL: https://wiki.aalto.fi/spaces/OPIT/pages/180301013/LECTURE+RECORDING+POLICY
- Read: 2026-11-14 (page dated 29.10.2020).
- (d) Recordings students make are for personal use only and must not be shared or re-used. Under the Finnish Copyright Act, private copies may not be used for other purposes. Students must make sure such copies are not made available to third persons. Misuse is handled as misconduct. This covers recordings, not slides, but it shows how Aalto reads "personal use" of course content.

## 12. Licences and copyrights (MyCourses help wiki)

- URL: https://wiki.aalto.fi/display/mchelp/Licences+and+copyrights
- Read: 2026-11-14. **Behind Aalto login.** We could not read it.

## 13. AI for students (student guide)

- URL: https://www.aalto.fi/en/student-guide/ai-for-students
- Read: 2026-11-14 (published 15.5.2026, updated 22.10.2026).
- (d) Only put in material that is public or that the course explicitly allows. Do not put the teacher's unpublished or confidential material into public services. Quote: "Do not share the teacher's unpublished materials or confidential content in public services." Never enter personal data such as student numbers. Make sure you have the right to use the material. Aalto recommends its own **Aalto AI Assistant** because it does not use your data to train models.
- (e) AI may be used to support learning unless the teacher says otherwise. Teachers can restrict it per course or assignment. AI-generated text may not be handed in directly or unmodified as your own work. In coursework, mark what is AI-generated and name the model or service and the date. Every thesis must say whether and how AI was used.

## 14. Guidance for the use of AI in teaching and learning at Aalto (university guidance)

- URL: https://www.aalto.fi/en/services/guidance-for-the-use-of-artificial-intelligence-in-teaching-and-learning-at-aalto-university
- Read: 2026-11-14 (approved 1 Aug 2023, item 4 updated 13 May 2025, page updated 20.10.2026).
- (d) Teachers may only put student work into systems Aalto has approved, for copyright and privacy reasons. It does not directly cover students putting teachers' material into AI. It also warns against creating accounts in systems that have not passed Aalto's security check.
- (e) AI is allowed as a support unless instructed otherwise. A teacher may restrict it per course or task and must state the limits in the assessment criteria. Using AI against the teacher's instructions counts as cheating. Quote: "AI-generated text cannot be presented as is as the student's own written response." The teacher may ask the student to describe how AI was used.

---

## Verdicts

| Point | Verdict | What it means for the plan |
|---|---|---|
| **(a)** Third-party tool signs in as her | **Unclear, leaning no** | A8 forbids giving your own login to another party. A9 says access is personal and traceable to one person, and shared use needs the system owner's approval. Whether a key she creates herself in the **official Moodle app flow**, and that we then hold on our server, counts as "giving her login" is not addressed anywhere. MyCourses publishes no terms of its own, and Aalto documents the Moodle app only for OpenLearning. **Ask Aalto IT (M0-10)** before relying on the server-held key. Until then: one user only, no password ever reaches us, and she can revoke the key herself. |
| **(b)** Automated access or scraping | **Unclear** | No rule names APIs, scripts or scraping. The binding rules forbid unnecessary strain, breaching systems and getting data without authorisation. Reading **her own** courses through Moodle's official web-service API at a gentle rate looks closest to normal use, but nothing says so. Keep polling light, read only what she can already see, and **ask in M0-10** whether Moodle web-service access is permitted for MyCourses. |
| **(c)** Sharing a personal key or password | **No for her password. Unclear for the app key** | A9 is plain: usernames and passwords may not be disclosed to anyone, and storing passwords in plain text is prohibited. **Ready must never ask for, see or store her Aalto password.** The Moodle app key is not mentioned. Sealing it on our server is the grey zone: whether it counts as disclosing a credential is the same question as (a). Put it in M0-10. |
| **(d)** Sending teachers' material to AI services | **No by default** (allowed only for public or course-permitted material) | The student guide allows only public or explicitly course-permitted material, and says not to put teachers' unpublished material into public services. It also says to check your right to use the material and recommends Aalto AI Assistant. Sending MyCourses slides and handouts to outside AI models by default conflicts with this. Options: send only what is public or what the course allows (a per-course switch she turns on), keep personal data out, check whether our AI provider counts as a "public service", and **ask in M0-10** whether an API with no training and no retention is acceptable. |
| **(e)** AI-written coursework | **No** | AI-written text may not be handed in as her own. Using AI against a teacher's rules is cheating, and AI use must be disclosed (model and date). Ready may explain, quiz and plan, but **must not write work she hands in**. The hand-in-on-her-tap step should upload only files she made. It could remind her to check the course's AI rules and to add a disclosure. |

**Could not reach:** the Policy of sanctions for IT offences (download failed); the MyCourses help page "Licences and copyrights" (needs Aalto login); the ISMS hub page for A8 (403, needs Aalto login), so we could not check for a newer version than A8 v1.0. No Aalto page on whether the Moodle mobile app or its key flow is supported for MyCourses was found.
