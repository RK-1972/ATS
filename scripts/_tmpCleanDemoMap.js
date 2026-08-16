require("dotenv").config();
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  const demoEmail = "demo.candidate@optalynx.demo";

  try {
    const candidateResult = await pool.query(
      "SELECT candidate_id FROM cand_mstr WHERE email_id = $1",
      [demoEmail]
    );
    const candidateIds = candidateResult.rows.map((row) => row.candidate_id);
    if (!candidateIds.length) return;

    const mapResult = await pool.query(
      "SELECT map_id FROM candidate_req_map WHERE candidate_id = ANY($1::int[])",
      [candidateIds]
    );
    const mapIds = mapResult.rows.map((row) => row.map_id);

    if (mapIds.length) {
      const schedules = await pool.query(
        "SELECT schedule_id FROM interview_schedule_trn WHERE map_id = ANY($1::int[])",
        [mapIds]
      );
      const scheduleIds = schedules.rows.map((row) => row.schedule_id);

      if (scheduleIds.length) {
        await pool.query(
          "DELETE FROM interview_feedback_hdr WHERE schedule_id = ANY($1::int[])",
          [scheduleIds]
        );
        await pool.query(
          "DELETE FROM interview_schedule_trn WHERE schedule_id = ANY($1::int[])",
          [scheduleIds]
        );
      }

      await pool.query("DELETE FROM im_interviews WHERE map_id = ANY($1::int[])", [mapIds]);
      await pool.query("DELETE FROM candidate_req_map WHERE map_id = ANY($1::int[])", [mapIds]);
    }

    const offers = await pool.query(
      "SELECT offer_id FROM om_offers WHERE candidate_id = ANY($1::int[])",
      [candidateIds]
    );
    for (const row of offers.rows) {
      const offerId = row.offer_id;
      const letters = await pool.query(
        "SELECT letter_id FROM om_offer_letters WHERE offer_id = $1",
        [offerId]
      );
      for (const letter of letters.rows) {
        await pool.query(
          "DELETE FROM om_offer_letter_ctc WHERE letter_id = $1",
          [letter.letter_id]
        );
      }
      await pool.query("DELETE FROM om_offer_letters WHERE offer_id = $1", [offerId]);
      await pool.query("DELETE FROM om_offers WHERE offer_id = $1", [offerId]);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
