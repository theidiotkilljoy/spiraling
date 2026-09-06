import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";

import {
  getAuth,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import {
  getDatabase,
  ref,
  push,
  set,
  query,
  limitToLast,
  onChildAdded,
  onValue,
  serverTimestamp,
  get,
  remove,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

import {
  firebaseConfig,
  DEFAULT_DIFFICULTY,
  HISTORY_LIMIT
} from "./firebase-config.js";


/* -------------------------------------------------------
   PAGE ELEMENTS
------------------------------------------------------- */

const form = document.querySelector("#roll-form");
const nameInput = document.querySelector("#player-name");
const diceInput = document.querySelector("#dice-count");
const panicInput = document.querySelector("#panic-count");
const advantageInput = document.querySelector("#advantage");
const rollButton = document.querySelector("#roll-button");

const liveName = document.querySelector("#live-name");
const liveDice = document.querySelector("#live-dice");
const liveResult = document.querySelector("#live-result");
const livePanic = document.querySelector("#live-panic");

const historyPanel = document.querySelector("#history");

const dmControls = document.querySelector("#dm-controls");
const difficultyInput = document.querySelector("#difficulty");


/* -------------------------------------------------------
   DICE IMAGE ASSETS
------------------------------------------------------- */

const ASSETS = {
  normal1: "assets/1.png",
  success: "assets/success.png",
  ten: "assets/10.png",
  panic1: "assets/crit1.png"
};


/* -------------------------------------------------------
   APP STATE
------------------------------------------------------- */

let db = null;
let serverOffset = 0;

const roomId = ensureRoomId();

let initialized = false;
let currentDifficulty = DEFAULT_DIFFICULTY;
let isDmOwner = false;

const dmMode =
  new URLSearchParams(window.location.search).get("dm") === "1";

const seenRolls = new Set();


/* -------------------------------------------------------
   FIREBASE
------------------------------------------------------- */

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

start().catch((error) => {
  console.error("Startup error:", error);
  rollButton.disabled = true;
});


async function start() {
  await signInAnonymously(auth);

  db = getDatabase(app);

  onValue(
    ref(db, ".info/serverTimeOffset"),
    (snapshot) => {
      serverOffset = Number(snapshot.val() || 0);
    }
  );

  await initializeDifficulty();

  subscribeToDifficulty();
  subscribeToRolls();

  initialized = true;
  rollButton.disabled = false;
}


/* -------------------------------------------------------
   ROOM ID
------------------------------------------------------- */

function ensureRoomId() {
  const hash =
    window.location.hash
      .replace(/^#/, "")
      .trim();

  if (/^[a-zA-Z0-9_-]{1,40}$/.test(hash)) {
    return hash;
  }

  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);

  const generated =
    Array.from(
      bytes,
      (byte) => byte.toString(36).padStart(2, "0")
    )
      .join("")
      .slice(0, 14);

  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#${generated}`
  );

  return generated;
}


/* -------------------------------------------------------
   DIFFICULTY / DM CONTROLS
------------------------------------------------------- */

async function initializeDifficulty() {

  const difficultyRef =
    ref(db, `rooms/${roomId}/settings/difficulty`);

  const difficultySnapshot =
    await get(difficultyRef);

  const storedDifficulty =
    clampInt(
      difficultySnapshot.val() ?? DEFAULT_DIFFICULTY,
      1,
      5
    );

  currentDifficulty = storedDifficulty;

  if (dmMode) {

    dmControls.hidden = false;

    difficultyInput.value =
      String(currentDifficulty);

    if (!difficultySnapshot.exists()) {

      await set(
        difficultyRef,
        currentDifficulty
      );

    }
  }
}


function subscribeToDifficulty() {
  onValue(
    ref(
      db,
      `rooms/${roomId}/settings/difficulty`
    ),
    (snapshot) => {

      currentDifficulty =
        clampInt(
          snapshot.val() ?? DEFAULT_DIFFICULTY,
          1,
          5
        );

      if (dmMode) {
        difficultyInput.value =
          String(currentDifficulty);
      }
    }
  );
}


difficultyInput.addEventListener(
  "change",
  async () => {

    if (
      !db ||
      !dmMode
    ) {
      return;
    }

    const nextDifficulty =
      clampInt(
        difficultyInput.value,
        1,
        5
      );

    difficultyInput.value =
      String(nextDifficulty);

    try {
      await set(
        ref(
          db,
          `rooms/${roomId}/settings/difficulty`
        ),
        nextDifficulty
      );

    } catch (error) {
      console.error(
        "Difficulty update failed:",
        error
      );

      difficultyInput.value =
        String(currentDifficulty);
    }
  }
);


/* -------------------------------------------------------
   TIME
------------------------------------------------------- */

function serverNow() {
  return Date.now() + serverOffset;
}


/* -------------------------------------------------------
   RANDOM D10
------------------------------------------------------- */

function secureD10() {
  const values =
    new Uint32Array(1);

  const max =
    Math.floor(
      0x100000000 / 10
    ) * 10;

  do {
    crypto.getRandomValues(values);
  } while (values[0] >= max);

  return (values[0] % 10) + 1;
}


/* -------------------------------------------------------
   BUILD DICE POOL
------------------------------------------------------- */

function buildPool(
  totalDice,
  panicDice
) {

  const panicUsed =
    Math.min(
      totalDice,
      panicDice
    );

  const normalUsed =
    totalDice - panicUsed;

  const dice = [];


  for (
    let i = 0;
    i < normalUsed;
    i++
  ) {
    dice.push({
      type: "normal",
      value: secureD10()
    });
  }


  for (
    let i = 0;
    i < panicUsed;
    i++
  ) {
    dice.push({
      type: "panic",
      value: secureD10()
    });
  }


  /*
    Randomize visual order.
    Panic dice still retain their type.
  */

  for (
    let i = dice.length - 1;
    i > 0;
    i--
  ) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);

    const j =
      random[0] % (i + 1);

    [
      dice[i],
      dice[j]
    ] = [
      dice[j],
      dice[i]
    ];
  }


  return scorePool(dice);
}


/* -------------------------------------------------------
   SCORE A DICE POOL
------------------------------------------------------- */

function scorePool(dice) {

  let successes = 0;
  let tens = 0;

  let normalOnes = 0;
  let panicOnes = 0;
  let panicTens = 0;


  for (const die of dice) {

    if (die.value === 10) {
      tens += 1;
    }


    /*
      NORMAL DIE

      1     = potential Panic
      2-5   = 0 successes
      6-9   = 1 success
      10    = 2 successes
    */

    if (die.type === "normal") {

      if (die.value === 1) {
        normalOnes += 1;
      }

      if (
        die.value >= 6 &&
        die.value <= 9
      ) {
        successes += 1;
      }

      if (die.value === 10) {
        successes += 2;
      }

    }


    /*
      PANIC DIE

      1     = Critical Fail if check fails
      2-9   = 0 successes
      10    = 1 success + remove Panic
    */

    else {

      if (die.value === 1) {
        panicOnes += 1;
      }

      if (die.value === 10) {
        successes += 1;
        panicTens += 1;
      }

    }
  }


  /*
    Two 10s = Critical Pass.
  */

  const criticalPass =
    tens >= 2;


  /*
    Critical Pass automatically passes.
    Otherwise successes must meet difficulty.
  */

  const passed =
    criticalPass ||
    successes >= currentDifficulty;


  /*
    A Panic 1 only becomes a Critical Fail
    when the overall check fails.
  */

  const criticalFail =
    !passed &&
    panicOnes > 0;


  /*
    A normal 1 causes Panic only if
    the overall check fails.
  */

  const panicAdded =
    !passed &&
    normalOnes > 0;


  /*
    Panic is removed if:

    - a Panic die rolls 10
    OR
    - the roll is a Critical Pass
  */

  const panicRemoved =
    panicTens > 0 ||
    criticalPass;


  let result = "FAIL";

  if (criticalFail) {
    result = "CRITICAL FAIL";
  }

  else if (criticalPass) {
    result = "CRITICAL PASS";
  }

  else if (passed) {
    result = "PASS";
  }


  return {
    dice,
    successes,
    tens,
    normalOnes,
    panicOnes,
    panicTens,
    result,
    panicAdded,
    panicRemoved
  };
}


/* -------------------------------------------------------
   ADVANTAGE
------------------------------------------------------- */

function outcomeRank(pool) {

  const ranks = {
    "CRITICAL FAIL": 0,
    "FAIL": 100,
    "PASS": 200,
    "CRITICAL PASS": 300
  };

  const base =
    ranks[pool.result] ?? 0;


  return (
    base +

    (pool.panicRemoved
      ? 20
      : 0) -

    (pool.panicAdded
      ? 10
      : 0) +

    Math.min(
      pool.successes,
      9
    )
  );
}


function selectBestPool(pools) {

  let bestIndex = 0;

  for (
    let i = 1;
    i < pools.length;
    i++
  ) {

    if (
      outcomeRank(pools[i]) >
      outcomeRank(pools[bestIndex])
    ) {
      bestIndex = i;
    }
  }

  return bestIndex;
}


/* -------------------------------------------------------
   ROLL BUTTON
------------------------------------------------------- */

form.addEventListener(
  "submit",
  async (event) => {

    event.preventDefault();


    if (!initialized) {
      console.warn(
        "Firebase has not initialized yet."
      );

      return;
    }


    const player =
      nameInput.value
        .trim()
        .slice(0, 32);


    const totalDice =
      clampInt(
        diceInput.value,
        1,
        5
      );


    const requestedPanic =
      clampInt(
        panicInput.value,
        0,
        3
      );


    /*
      Panic dice replace normal dice.
      They cannot exceed the total pool.
    */

    const panicDice =
      Math.min(
        requestedPanic,
        totalDice
      );


    const advantage =
      advantageInput.checked;


    if (!player) {
      return;
    }


    /*
      Roll once normally.

      If Advantage is checked,
      roll a second complete pool.
    */

    const pools = [
      buildPool(
        totalDice,
        panicDice
      )
    ];


    if (advantage) {

      pools.push(
        buildPool(
          totalDice,
          panicDice
        )
      );

    }


    const selected =
      selectBestPool(pools);


    const chosen =
      pools[selected];


    /*
      Create a new shared roll
      in Firebase.
    */

    const eventRef =
      push(
        ref(
          db,
          `rooms/${roomId}/rolls`
        )
      );


    const payload = {

      player,

      totalDice,

      panicDice,

      advantage,

      pools,

      selected,

      result:
        chosen.result,

      panicAdded:
        chosen.panicAdded,

      panicRemoved:
        chosen.panicRemoved,

      difficulty:
        currentDifficulty,

      /*
        Gives all browsers roughly
        the same reveal time.
      */

      revealAt:
        serverNow() + 1100,

      createdAt:
        serverTimestamp()
    };


    rollButton.disabled = true;


    try {

      await set(
        eventRef,
        payload
      );

      await trimHistory();

    } catch (error) {

      console.error(
        "Roll failed:",
        error
      );

    } finally {

      rollButton.disabled = false;

    }

  }
);


/* -------------------------------------------------------
   RECEIVE SHARED ROLLS
------------------------------------------------------- */

function subscribeToRolls() {

  const rollsQuery =
    query(
      ref(
        db,
        `rooms/${roomId}/rolls`
      ),
      limitToLast(
        HISTORY_LIMIT
      )
    );


  onChildAdded(
    rollsQuery,
    (snapshot) => {

      if (
        seenRolls.has(
          snapshot.key
        )
      ) {
        return;
      }


      seenRolls.add(
        snapshot.key
      );


      const roll =
        normalizeRoll(
          snapshot.val()
        );


      addHistoryCard(
        snapshot.key,
        roll
      );


      const untilReveal =
        Number(
          roll.revealAt || 0
        ) -
        serverNow();


      /*
        Only animate relatively
        recent rolls.

        Old history should not replay
        when somebody joins the room.
      */

      const isFresh =
        untilReveal > -2500;


      if (isFresh) {

        showLiveRoll(
          roll,
          Math.max(
            0,
            untilReveal
          )
        );

      }

    }
  );
}


/* -------------------------------------------------------
   VALIDATE FIREBASE DATA
------------------------------------------------------- */

function normalizeRoll(raw) {

  const pools =
    Array.isArray(raw?.pools)
      ? raw.pools
      : [];


  return {

    player:
      String(
        raw?.player || ""
      ).slice(0, 32),

    advantage:
      Boolean(
        raw?.advantage
      ),

    pools,

    selected:
      clampInt(
        raw?.selected ?? 0,
        0,
        Math.max(
          0,
          pools.length - 1
        )
      ),

    result:
      String(
        raw?.result || "FAIL"
      ),

    panicAdded:
      Boolean(
        raw?.panicAdded
      ),

    panicRemoved:
      Boolean(
        raw?.panicRemoved
      ),

    revealAt:
      Number(
        raw?.revealAt || 0
      ),

    createdAt:
      Number(
        raw?.createdAt || 0
      )
  };
}


/* -------------------------------------------------------
   LIVE ROLL DISPLAY
------------------------------------------------------- */

async function showLiveRoll(
  roll,
  delayMs
) {

  liveName.textContent =
    roll.player;

  liveResult.textContent =
    "";

  liveResult.className =
    "result";

  livePanic.textContent =
    "";

  liveDice.innerHTML =
    "";


  /*
    Display temporary rolling dice.
  */

  const rollingRows =
    roll.pools.map(
      (pool) =>
        renderDiceRow(
          pool.dice,
          true,
          false
        )
    );


  rollingRows.forEach(
    (row) => {
      liveDice.appendChild(row);
    }
  );


  await sleep(
    delayMs + 650
  );


  /*
    Reveal actual dice.
  */

  liveDice.innerHTML =
    "";


  roll.pools.forEach(
    (pool, index) => {

      liveDice.appendChild(
        renderDiceRow(
          pool.dice,
          false,
          index === roll.selected
        )
      );

    }
  );


  liveResult.textContent =
    roll.result;


  liveResult.className =
    `result ${resultClass(
      roll.result
    )}`;


  if (roll.panicAdded) {

    livePanic.textContent =
      "YOU'RE PANICKING";

  }
}


/* -------------------------------------------------------
   DICE DISPLAY
------------------------------------------------------- */

function renderDiceRow(
  dice,
  rolling = false,
  chosen = false
) {

  const row = document.createElement("div");

  row.className =
    `dice-row${chosen ? " chosen" : ""}`;

  for (const dieData of dice) {

    const type =
      dieData.type === "panic"
        ? "panic"
        : "normal";

    /*
      While rolling, show a blank die.
      Do NOT generate a fake/random value.
    */
    const shownValue =
      rolling
        ? null
        : clampInt(
            dieData.value,
            1,
            10
          );

    row.appendChild(
      renderDie(
        type,
        shownValue,
        rolling
      )
    );
  }

  return row;
}


function renderDie(
  type,
  value,
  rolling
) {

  const die = document.createElement("div");

  die.className =
    `die ${type}${rolling ? " rolling" : ""}`;

  /*
    During the rolling animation,
    leave the die completely blank.
  */
  if (rolling) {

    die.setAttribute(
      "aria-label",
      `${type === "panic" ? "Panic" : "Normal"} die rolling`
    );

    return die;
  }

  die.setAttribute(
    "aria-label",
    `${type === "panic" ? "Panic" : "Normal"} die: ${value}`
  );

  const asset =
    faceAsset(
      type,
      value
    );

  const fallback =
    document.createElement("span");

  fallback.className =
    "fallback";

  fallback.textContent =
    fallbackFace(
      type,
      value
    );

  if (asset) {

    const img =
      document.createElement("img");

    img.alt = "";
    img.src = asset;

    img.addEventListener(
      "error",
      () => {
        img.classList.add("missing");
      },
      {
        once: true
      }
    );

    die.append(
      img,
      fallback
    );

  } else {

    die.appendChild(
      fallback
    );
  }

  return die;
} 


/* -------------------------------------------------------
   WHICH IMAGE APPEARS ON A DIE
------------------------------------------------------- */

function faceAsset(
  type,
  value
) {

  /*
    PANIC DIE

    1  -> crit1.png
    10 -> 10.png
    everything else blank
  */

  if (type === "panic") {

    if (value === 1) {
      return ASSETS.panic1;
    }

    if (value === 10) {
      return ASSETS.ten;
    }

    return null;
  }


  /*
    NORMAL DIE

    1    -> 1.png
    6-9  -> success.png
    10   -> 10.png
    2-5  -> blank
  */

  if (value === 1) {
    return ASSETS.normal1;
  }

  if (
    value >= 6 &&
    value <= 9
  ) {
    return ASSETS.success;
  }

  if (value === 10) {
    return ASSETS.ten;
  }

  return null;
}


/* -------------------------------------------------------
   FALLBACK SYMBOLS IF IMAGE IS MISSING
------------------------------------------------------- */

function fallbackFace(
  type,
  value
) {

  if (type === "panic") {

    if (value === 1) {
      return "✕";
    }

    if (value === 10) {
      return "◆";
    }

    return "";
  }


  if (value === 1) {
    return "1";
  }

  if (
    value >= 6 &&
    value <= 9
  ) {
    return "•";
  }

  if (value === 10) {
    return "◆";
  }

  return "";
}


/* -------------------------------------------------------
   HISTORY PANEL
------------------------------------------------------- */

function addHistoryCard(
  key,
  roll
) {

  const card =
    document.createElement(
      "article"
    );


  card.className =
    "history-card";


  card.dataset.key =
    key;


  const name =
    document.createElement(
      "div"
    );


  name.className =
    "history-name";


  name.textContent =
    roll.player;


  const diceArea =
    document.createElement(
      "div"
    );


  diceArea.className =
    "dice-area";


  roll.pools.forEach(
    (pool, index) => {

      diceArea.appendChild(
        renderDiceRow(
          pool.dice,
          false,
          index === roll.selected
        )
      );

    }
  );


  const result =
    document.createElement(
      "div"
    );


  result.className =
    "history-result";


  result.textContent =
    roll.result;


  card.append(
    name,
    diceArea,
    result
  );


  if (roll.panicAdded) {

    const panic =
      document.createElement(
        "div"
      );


    panic.className =
      "history-panic";


    panic.textContent =
      "YOU'RE PANICKING";


    card.appendChild(
      panic
    );

  }


  /*
    Newest roll at top.
  */

  historyPanel.prepend(
    card
  );


  while (
    historyPanel.children.length >
    HISTORY_LIMIT
  ) {

    historyPanel
      .lastElementChild
      ?.remove();

  }
}


/* -------------------------------------------------------
   TRIM FIREBASE HISTORY
------------------------------------------------------- */

async function trimHistory() {

  const rollsRef =
    ref(
      db,
      `rooms/${roomId}/rolls`
    );


  const snapshot =
    await get(
      rollsRef
    );


  if (!snapshot.exists()) {
    return;
  }


  const entries =
    Object.entries(
      snapshot.val() || {}
    )
      .map(
        ([key, value]) => ({
          key,
          createdAt:
            Number(
              value?.createdAt || 0
            )
        })
      )
      .sort(
        (a, b) =>
          a.createdAt -
          b.createdAt
      );


  const excess =
    entries.length -
    HISTORY_LIMIT;


  if (excess <= 0) {
    return;
  }


  await Promise.all(

    entries
      .slice(
        0,
        excess
      )
      .map(
        (entry) =>
          remove(
            ref(
              db,
              `rooms/${roomId}/rolls/${entry.key}`
            )
          )
      )

  );
}


/* -------------------------------------------------------
   HELPERS
------------------------------------------------------- */

function resultClass(result) {

  return result
    .toLowerCase()
    .replace(
      /\s+/g,
      "-"
    );
}


function clampInt(
  value,
  min,
  max
) {

  const number =
    Number.parseInt(
      value,
      10
    );


  if (
    !Number.isFinite(
      number
    )
  ) {
    return min;
  }


  return Math.max(
    min,
    Math.min(
      max,
      number
    )
  );
}


function sleep(ms) {

  return new Promise(
    (resolve) => {

      setTimeout(
        resolve,
        Math.max(
          0,
          ms
        )
      );

    }
  );
}
