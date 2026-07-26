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

  /**
   * Everything that is not a confirm-or-correct of an owner assumption.
   *
   * `slide` places the question beside its evidence in the deck; questions with
   * `slide: null` are grouped onto generated slides at the end. `controls[]` is
   * rendered by renderControls() below, so BOTH surfaces emit the same markup and
   * `collect()` finds the same `data-k` / `data-group` hooks on either one.
   *
   * `new: true` marks a question added by the 2026-07-26 audit — see
   * .claude/PRPs/plans/calibration-question-audit.plan.md.
   */
  const QUESTIONS = [
    // ── The audit's headline gap ────────────────────────────────────────────
    {
      id: 'weights', slide: 's11', new: true,
      ask: 'Which of these matters most — and which least?',
      why: 'These five are what order your entire list, and they have been equal-weight placeholders since we set them up. Nobody has ever asked you. A full ranking is a big request, so: just the top one and the bottom one.',
      yamlPath: 'score_components[].weight',
      controls: [
        { type: 'pills', group: 'weight_top', label: 'Matters MOST', options: [
          ['trade_fit', 'Right kind of work'], ['package_size_fit', 'Right size'],
          ['timing', 'Caught early'], ['geography', 'Close to home'], ['evidence_quality', 'Reliable record'] ] },
        { type: 'pills', group: 'weight_bottom', label: 'Matters LEAST', options: [
          ['trade_fit', 'Right kind of work'], ['package_size_fit', 'Right size'],
          ['timing', 'Caught early'], ['geography', 'Close to home'], ['evidence_quality', 'Reliable record'] ] },
      ],
    },
    {
      id: 'relationship_price', slide: 'sGC', new: true,
      ask: 'Once we can tell you have worked with a GC — how much should that count?',
      why: 'It counts for nothing today because we have never had the data. You are giving it to us now, so this is the moment to price it.',
      yamlPath: 'score_components -> relationship_lift (not yet wired)',
      controls: [{ type: 'pills', group: 'relationship_price', options: [
        ['nudge', 'A nudge, like +3'], ['strong', 'A big lift'],
        ['top', 'Straight to the top'], ['none', 'Should not matter'] ] }],
    },
    {
      id: 'verified_price', slide: 's13', new: true,
      ask: 'And a confirmed real company — worth anything on its own?',
      why: '120 of your jobs carry it and it is currently worth nothing. It is the signal that says you can actually find out who to call, which may matter more than whether they are nearby.',
      yamlPath: 'score_components -> verified_gc_on_project',
      controls: [{ type: 'pills', group: 'verified_price', options: [
        ['none', 'Nothing — just show me'], ['small', 'A small lift'], ['strong', 'A real lift'] ] }],
    },
    {
      id: 'closed_windows', slide: 's4', new: true,
      ask: 'What should we do with the ones already past bidding?',
      why: 'They are 46% of your priority list. We show them today because a late call sometimes still lands — but if they are noise to you, that is nearly half the list back.',
      yamlPath: 'rules -> routing (closed-window handling)',
      controls: [{ type: 'pills', group: 'closed_windows', options: [
        ['hide', 'Hide them'], ['demote', 'Show, but lower'],
        ['keep', 'Keep — late calls land'] ] }],
    },

    // ── Section 2 — scope & constraints (was intake-only) ────────────────────
    {
      id: 'scope', slide: null,
      ask: 'What exactly do you do — and what do you not?',
      why: 'We match on permit text. Knowing you do <b>Level 5 skim</b> but not <b>acoustic ceiling grid</b> changes which jobs reach you. Name anything you subcontract out or refuse.',
      yamlPath: 'capabilities[]',
      controls: [
        { type: 'textarea', k: 'scope_drywall', label: 'Drywall scope', placeholder: 'Hang, tape, texture, Level 5 skim, metal stud framing, shaftwall, ACT grid, insulation…' },
        { type: 'textarea', k: 'scope_paint', label: 'Painting scope', placeholder: 'Interior, exterior, spray, specialty coatings, Venetian plaster, industrial…' },
      ],
    },
    {
      id: 'scope_book', slide: null, new: true,
      ask: 'Of the work you do, which should we push hardest?',
      why: 'We can already spot restoration, Level 5 / smooth wall, commercial TI and everyday hanging in permit text — but all four are deliberately unweighted until you say which earns best. Restoration in particular almost never appears as a permit, so if it is your best margin we have to hunt for it differently.',
      yamlPath: 'score_components -> scope book weighting (§12.3 signals)',
      controls: [{ type: 'pills', group: 'scope_book', options: [
        ['restoration', 'Water damage / restoration'], ['level5', 'Level 5 & smooth wall'],
        ['commercial_ti', 'Commercial TI'], ['everyday', 'Everyday hang & finish'] ] }],
    },
    {
      id: 'certs', slide: null,
      ask: 'Do you hold any specialty assembly certifications?',
      why: 'These are detectable in permit text, so a certification turns into a targeted search rather than a keyword match on &ldquo;drywall&rdquo;. They also weigh in Tier-1 general contractor bid evaluation.',
      yamlPath: 'capabilities[] -> assembly detection',
      controls: [
        { type: 'pills', group: 'certs_fire', label: 'Fire-rated / firestop', options: [
          ['yes', 'Certified'], ['capable', 'Do the work, not certified'], ['no', 'Neither'] ] },
        { type: 'pills', group: 'certs_acoustic', label: 'Acoustic STC 55–60+', options: [
          ['yes', 'Certified'], ['capable', 'Do the work, not certified'], ['no', 'Neither'] ] },
        { type: 'text', k: 'certifications_other', label: 'Manufacturer certifications, bonding line, anything else',
          placeholder: 'USG, National Gypsum, CertainTeed, ROCKWOOL, Trim-Tex; bonding capacity…' },
      ],
    },
    {
      id: 'capacity', slide: null,
      ask: 'Crew and capacity',
      why: 'Sets how many live opportunities are useful. If you can only carry three bids at once, a feed of thirty is noise — we would tighten rather than flood you.',
      yamlPath: 'calibration_pending -> capacity snapshot',
      controls: [
        { type: 'text', k: 'capacity_crews', label: 'Crews / headcount', placeholder: 'e.g. 2 crews, 9 total' },
        { type: 'text', k: 'capacity_concurrent_bids', label: 'Bids you can carry at once', placeholder: 'e.g. 4' },
        { type: 'text', k: 'capacity_sweet_spot', label: 'Sweet-spot job size', placeholder: 'e.g. $40k–$250k' },
      ],
    },
    {
      id: 'public_work', slide: null,
      ask: 'Public work, bonding, prevailing wage',
      why: 'Public projects are a large share of what we can see earliest. If you are not bonded or will not take prevailing-wage work, we should stop surfacing them entirely.',
      yamlPath: 'rules -> exclusion',
      controls: [
        { type: 'pills', group: 'public_work', options: [
          ['yes_active', 'Yes, we do public work'], ['yes_would', 'Not yet, but would'], ['no', 'No — exclude it'] ] },
        { type: 'text', k: 'bonding_notes', label: 'Bonding limit, union status, anything else', placeholder: 'e.g. bonded to $500k, non-union' },
      ],
    },
    {
      id: 'invitations', slide: null,
      ask: 'Where do bid invitations reach you today?',
      why: 'If you forward them to us, they fill the <b>Deadlines</b> section and we learn which GCs invite you — the strongest relationship signal there is. We only ever read what you send.',
      yamlPath: 'bid inbox -> deadlines section',
      controls: [
        { type: 'text', k: 'invitation_platforms', label: 'Platforms / how invitations arrive', placeholder: 'BuildingConnected, iSqFt, plain email…' },
        { type: 'text', k: 'forwarding_email', label: 'Address you would forward from', placeholder: 'estimating@…' },
      ],
    },
    {
      id: 'licence', slide: null,
      ask: 'Licence renewal',
      why: 'Our records show contractor registration <b>SOLISIL785NT</b> running through <b>11 August 2026</b> — about two weeks out. Confirm it is being renewed so nothing lapses in the public record we cite.',
      yamlPath: 'organization.contractor_registration',
      controls: [
        { type: 'pills', group: 'licence', options: [
          ['renewing', 'Renewing / already done'], ['changed', 'Details have changed'], ['unsure', 'Need to check'] ] },
        { type: 'text', k: 'other_entities', label: 'Any other entities or DBAs we should know about?', placeholder: 'We have one older closed entity on file and nothing else…', new: true },
      ],
    },

    // ── Section 3 — volume & timing (was intake-only) ────────────────────────
    {
      id: 'threshold', slide: null,
      ask: 'Does thirteen a week feel right?',
      why: 'Thirteen jobs cross your threshold in a typical week. Lower it and you see more, earlier, with more noise; raise it and only the strongest reach you.',
      yamlPath: 'delivery.priority_review_min',
      controls: [{ type: 'pills', group: 'threshold', options: [
        ['more', 'Show me more'], ['right', 'About right'], ['fewer', 'Fewer, stronger only'] ] }],
    },
    {
      id: 'age_window', slide: null,
      ask: 'How fresh does a “winnable now” job need to be?',
      why: 'The nearest ring holds far more at 60 days than at 30. Tighter means fewer but hotter.',
      yamlPath: 'delivery.easy_win.max_age_days',
      controls: [{ type: 'pills', group: 'age_window', options: [
        ['30', 'Last 30 days'], ['60', 'Last 60 days'], ['unsure', 'Not sure — your call'] ] }],
    },
    {
      id: 'digest_recipients', slide: null, new: true,
      ask: 'Who else should get the weekly email?',
      why: 'We have Javier (manager) and Daniel (supervisor) on file. One person reading it is one person who can be on holiday.',
      yamlPath: 'delivery -> recipients',
      controls: [{ type: 'text', k: 'digest_recipients', label: 'Additional recipients', placeholder: 'name@… , name@…' }],
    },
  ];

  /**
   * The seven WaaS landing pages built but withheld from search pending
   * confirmation Solis actually takes the work. Each `yes` flips one `indexable`
   * flag in apps/registry/scripts/solis-landing-pages.mjs — so this is not a
   * preference, it is a deploy switch.
   */
  const WAAS_SERVICES = [
    ['water-damage-drywall-repair', 'Water damage repair'],
    ['popcorn-ceiling-removal', 'Popcorn ceiling removal'],
    ['soundproof-drywall-installation', 'Soundproofing / QuietRock'],
    ['fire-rated-drywall-installation', 'Fire-rated assemblies'],
    ['metal-stud-framing-drywall', 'Metal stud framing + drywall'],
    ['seattle-drywall-contractor', 'Commercial work in Seattle'],
    ['bellevue-drywall-contractor', 'Commercial work in Bellevue'],
  ];

  /** ONE markup generator for both surfaces. If the deck and the form rendered
   *  their own controls, collect() would find different hooks on each and the
   *  export would quietly depend on which file you filled in. */
  function renderControls(controls) {
    return (controls || []).map((c) => {
      if (c.type === 'pills') {
        const opts = c.options.map(([v, label]) =>
          `<label><input type="radio" name="${c.group}" value="${v}"> ${label}</label>`).join('');
        return `${c.label ? `<div class="fl">${c.label}</div>` : ''}<div class="pills cc" data-group="${c.group}">${opts}</div>`;
      }
      if (c.type === 'textarea') {
        return `<label class="fl" for="f_${c.k}">${c.label}</label>
                <textarea id="f_${c.k}" data-k="${c.k}" rows="2" placeholder="${c.placeholder || ''}"></textarea>`;
      }
      return `<label class="fl" for="f_${c.k}">${c.label}</label>
              <input type="text" id="f_${c.k}" data-k="${c.k}" placeholder="${c.placeholder || ''}">`;
    }).join('');
  }

  global.CALIBRATION = { STORE, ASSUMPTIONS, RELATIONSHIPS, QUESTIONS, WAAS_SERVICES, renderControls };
})(window);
