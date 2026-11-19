-- Starting data for the hub: the Jesus People Network project and its task list.
-- No member emails and no payment content here: those are loaded at setup from private files.

INSERT OR IGNORE INTO projects (id, name, sort) VALUES ('jpn', 'Jesus People Network', 1);

INSERT OR IGNORE INTO tasks (project_id, id, title, task_group, sort_order, stopping_point, completed, completed_date, date_label) VALUES
  ('jpn', 'task-01', 'Sliding journey form — commitment, course sign-up, confirmation email', 'sp1-site', 1, 1, 1, 'Oct 1, 2026', 'Oct 1'),
  ('jpn', 'task-02', 'Home page desktop layout', 'sp1-site', 2, 1, 1, 'Sep 29, 2026', 'Sep 29'),
  ('jpn', 'task-03', 'Home page redesign — same branding, fuller layout', 'sp1-site', 3, 1, 1, 'Oct 20, 2026', 'Oct 20'),
  ('jpn', 'task-04', 'Mobile-friendly home page — single column', 'sp1-site', 4, 1, 1, 'Oct 24, 2026', 'Oct 24'),
  ('jpn', 'task-05', 'New site icon and FAQ with smooth expand/collapse', 'sp1-site', 5, 1, 1, 'Oct 26, 2026', 'Oct 26'),
  ('jpn', 'task-06', 'Clean system font styling (Instagram-style)', 'sp1-site', 6, 1, 1, 'Oct 26, 2026', 'Oct 26'),
  ('jpn', 'task-07', 'Creator accounts with unique shareable links', 'sp1-site', 7, 1, 1, 'Sep 25, 2026', 'Sep 25'),
  ('jpn', 'task-24', 'Statement of Faith page', 'sp1-site', 7.1, 1, 0, NULL, NULL),
  ('jpn', 'task-25', 'Legal pages (Terms of Service, Privacy Policy)', 'sp1-site', 7.2, 1, 0, NULL, NULL),
  ('jpn', 'task-26', 'Spam and bot protection', 'sp1-site', 7.3, 1, 0, NULL, NULL),
  ('jpn', 'task-08', 'Google sign-in button', 'sp1-auth', 8, 1, 1, 'Oct 20, 2026', 'Oct 20'),
  ('jpn', 'task-09', 'Straight to dashboard after Google sign-in', 'sp1-auth', 9, 1, 1, 'Oct 20, 2026', 'Oct 20'),
  ('jpn', 'task-10', 'Role-based routing after sign-in', 'sp1-auth', 10, 1, 1, 'Oct 20, 2026', 'Oct 20'),
  ('jpn', 'task-11', 'Sign-in page — works on phones and desktop', 'sp1-auth', 11, 1, 1, 'Oct 27, 2026', 'Oct 27'),
  ('jpn', 'task-12', 'Creator dashboard — engagement as visitor percentages', 'sp2', 12, 2, 1, 'Oct 26, 2026', 'Oct 26'),
  ('jpn', 'task-13', 'Share-your-link and follow-up dashboard', 'sp2', 13, 2, 1, 'Oct 24, 2026', 'Oct 24'),
  ('jpn', 'task-27', 'Apple sign-in', 'sp2', 13.5, 2, 0, NULL, NULL),
  ('jpn', 'task-14', 'Dashboard shows what visitors clicked', 'sp2', 14, 2, 1, 'Oct 28, 2026', 'Oct 28'),
  ('jpn', 'task-15', 'Dashboard cards — one per step, with people behind each', 'sp2', 15, 2, 1, 'Oct 30, 2026', 'Oct 30'),
  ('jpn', 'task-16', 'Creators directory — one card per creator', 'sp2', 16, 2, 1, 'Oct 26, 2026', 'Oct 26'),
  ('jpn', 'task-17', 'Admin page with sign-out and step overview', 'sp2', 17, 2, 1, 'Nov 2, 2026', 'Nov 2'),
  ('jpn', 'task-28', 'Creator dashboard and editor — remaining features', 'sp2', 17.1, 2, 0, NULL, NULL),
  ('jpn', 'task-29', 'Content blocks: finalize text, video, image, PDF, link/button', 'sp2', 17.2, 2, 0, NULL, NULL),
  ('jpn', 'task-18', 'Admin creator management, settings, templates and audit log', 'sp3', 18, 3, 0, NULL, NULL),
  ('jpn', 'task-19', 'Network-wide admin analytics', 'sp3', 19, 3, 0, NULL, NULL),
  ('jpn', 'task-20', 'Follow-up email with creator-specific content and CTA', 'sp3', 20, 3, 0, NULL, NULL),
  ('jpn', 'task-21', 'VisitorReach outbound link tracking', 'sp3', 21, 3, 0, NULL, NULL),
  ('jpn', 'task-22', 'Responsive/accessibility QA across devices', 'sp3', 22, 3, 0, NULL, NULL),
  ('jpn', 'task-23', 'Production deployment and handoff documentation', 'sp3', 25, 3, 0, NULL, NULL),
  ('jpn', 'task-30', 'Interest form — collect signups and maintain a subscriber list', 'sp2', 17.3, 2, 0, NULL, NULL),
  ('jpn', 'task-31', 'Database stress test — review schema integrity, indexes, constraints, and RLS policies', 'sp3', 22.1, 3, 0, NULL, NULL),
  ('jpn', 'task-32', 'TCPA compliance testing — consent capture, opt-in records, disclosure language, audit trail', 'sp3', 22.2, 3, 0, NULL, NULL),
  ('jpn', 'task-33', 'Code integrity stress test — XSS, injection, input validation, error handling', 'sp3', 22.3, 3, 0, NULL, NULL),
  ('jpn', 'task-34', 'Security stress test — auth bypass, API exposure, secret leaks, RLS enforcement', 'sp3', 22.4, 3, 0, NULL, NULL),
  ('jpn', 'task-35', 'High-volume lead test — simulate large lead batches, verify performance and data integrity', 'sp3', 22.5, 3, 0, NULL, NULL);

-- Built-in weekly updates (author 'build-log' has no '@', so the page shows it without a time).
INSERT INTO updates (project_id, week_label, items, notes, author_email, created_at)
SELECT 'jpn', v.week_label, v.items, '', 'build-log', v.created_at FROM (
  SELECT 'Week of Nov 16, 2026' AS week_label, '["Renamed Digital Collective to Jesus People Network on the live site, the design preview and this plan","Terms, Privacy, the Statement of Faith and the consent checkboxes use the new name; consent records are versioned, so older ones keep the wording people agreed to","The contact address and example links now use jesuspeoplenetwork.com (the domain still needs to be connected in Cloudflare)"]' AS items, 1794916800000 AS created_at
  UNION ALL
  SELECT 'Week of Nov 9, 2026' AS week_label, '["Added five stress-testing tasks to Stopping Point 3: database, TCPA compliance, code integrity, security and high-volume leads","Added the Updates tab for weekly meeting notes","Drafted a “Faith is already on the screen” section for the Why page with Pew Research and Luminate figures (not on the preview yet)"]' AS items, 1794312000000 AS created_at
) v
WHERE NOT EXISTS (SELECT 1 FROM updates WHERE project_id = 'jpn' AND author_email = 'build-log');
