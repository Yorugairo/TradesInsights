/**
 * The calibration question set — the ONE definition, read by both surfaces.
 *
 * `presentation.html` renders each question inline on the slide that shows its
 * evidence; `intake.html` renders the same set as a standalone leave-behind. Two
 * hand-maintained copies is how the deck ends up asking something the form does
 * not, and the customer answers a question nobody recorded.
 *
 * PLAIN SCRIPT, NOT AN ES MODULE, on purpose: these files are opened straight
 * from `file://` on a borrowed laptop. `import` is blocked by CORS on file://,
 * and a build step would make the artifact undemoable — which is the one thing
 * it must never be.
 */
(function (global) {
  /**
   * Storage key. DO NOT RENAME — answers may already be saved under it, and a new
   * key orphans them silently. The operator would discover that mid-session, with
   * the customer watching, and there is no recovery.
   */
  const STORE = 'solis-intake-2026-07-26';

  /**
   * Mirrors config/account-profiles.yaml -> accounts[solis_interiors].owner_assumed.
   * Each carries the `yamlPath` it maps to so the export can be applied as a config
   * diff rather than re-typed — re-typing is where a calibration answer silently
   * becomes a different setting.
   *
   * `slide` is the id of the slide whose evidence this question is about. That is
   * the whole point of the merge: ask "is +3 right?" while the 67 is on screen.
   */
  const ASSUMPTIONS = [
    {
      id: 'territory',
      slide: 'sD',
      setting: 'You work Thurston, Pierce, Lewis and King counties.',
      why: 'This is the outer boundary of everything we show you. A county that is not on this list is invisible to you, however good the job.',
      yamlPath: 'territory.counties_included',
      ask: 'Is that the right boundary?',
    },
    {
      id: 'geo_weight',
      slide: 's9',
      setting: 'Home metro outranks King commercial; Pierce sits about even.',
      why: 'We down-weighted King as distant volume, cutting it from 334 priority jobs to 142. <b>Distance is probably the wrong filter.</b> A drive is only expensive relative to what you drove past: a data centre, a rated shaftwall or a Level 5 job in Medina pays for the mileage, while generic Level 4 hanging in King means passing dozens of equivalent Pierce jobs to get there. The likely fix is qualifying by <b>job type</b> rather than de-rating a whole county.',
      yamlPath: 'score_components -> geography',
      ask: 'Should we qualify King by job type instead of de-rating the county?',
    },
    {
      id: 'stage_weight',
      slide: 's4',
      setting: 'A project at application stage ranks ABOVE an equivalent issued one.',
      why: 'Earlier means more time to get in before the GC locks its subs. If you would rather see confirmed, funded, issued work only, this flips.',
      yamlPath: 'rules -> routing (stage timing)',
      ask: 'Earlier and less certain, or later and confirmed?',
    },
    {
      id: 'warm_gc',
      slide: 's13',
      setting: 'A GC that is active near you, on your kind of work, gives the job +3 points.',
      why: 'Note what this is NOT: it does not mean you have worked with them &mdash; we have never asked, so we do not know. It means the same verified company keeps turning up in your territory on relevant jobs (2+ projects). Small on purpose: a nudge, not a reordering. Until this week it had never once fired, so today is the first run where it moved anything.',
      yamlPath: 'score_components -> warm_gc_active',
      ask: 'Is +3 right, too shy, or too much?',
    },
    {
      id: 'bands',
      slide: 's10',
      setting: 'Proximity bands of 20, 35 and 50 miles from Lacey.',
      why: 'Drives the &ldquo;winnable now&rdquo; ordering, nearest first. The 35-mile ring holds nearly everything &mdash; stretching to 50 adds only seven jobs.',
      yamlPath: 'delivery.easy_win.radius_bands_mi',
      ask: 'Are those the right rings?',
    },
    {
      id: 'no_floor',
      slide: 's10',
      setting: 'No minimum job size — no job is too small.',
      why: 'We never filter on price from below. If there is a size beneath which a bid is not worth writing, saying so removes real noise.',
      yamlPath: 'delivery.easy_win.min_valuation_usd',
      ask: 'Is there a size below which you would not bid?',
    },
    {
      id: 'king_small',
      slide: 's9',
      setting: 'King County jobs under $10k go to the digest, not to priority.',
      why: 'A small job two hours away rarely pays for the drive. Applies only to King.',
      yamlPath: 'rules -> routing (King banding)',
      ask: 'Right threshold, or wrong idea entirely?',
    },
  ];

  /** Relationship states offered per GC. Mirrors RELATIONSHIP_STATES in
   *  packages/intelligence/src/relationships.ts — only "Avoid"/"Blocked" are
   *  wired to anything today (they suppress alerts); the rest are captured for
   *  the relationship signal that does not exist yet. */
  const RELATIONSHIPS = ['', 'Worked with', 'Want to work with', 'Avoid', 'Blocked by incumbent'];

  global.CALIBRATION = { STORE, ASSUMPTIONS, RELATIONSHIPS };
})(window);
