/** Run the parser over real library filenames and print results for eyeballing. */
import {
  parseEpisodeFile, parseTitle, parseSeasonFolder, parseSeasonRange, seriesKey,
} from '../server/src/scan/parse.js';

const EPISODES = [
  'Arcane.S01E01.Welcome.to.the.Playground.1080p.NF.WEB-DL.DDP5.1.DV.HDR.H.265-FLUX.mkv',
  'Ben.10.Alien.Force.S01E01.Ben.10.Returns.Pt.1.1080p.WEB-DL.AAC2.0.H.264-iT00NZ.mkv',
  'Ben.10.2005.S01E01.And.Then.There.Were.10.1080p.Max.WEB-DL.AAC2.0.H.264-RegEdits.mkv',
  'Ben.10.S04E01.Perfect.Day.1080p.WEB-DL.AAC2.0.H.264-SA89.mkv',
  'Generator.Rex.S01E01.Day.That.Everything.Changed.AAC2.0.1080p.WEBRip.x265-PoF.mkv',
  'Green.Lantern.The.Animated.Series.S01E01.Beware.My.Power.Part.1.1080p.BluRay.REMUX.AVC.DTS-HD.MA.2.0-EPSiLON.mkv',
  'Invincible.2021.S01E01.1080p.AMZN.WEB-DL.H.264.DDP5.1-PTerWEB.mkv',
  'Invincible.2025.S03E01.1080p.AMZN.WEB-DL.H.264.DDP5.1-UBWEB.mkv',
  'Justice.League.S01E01.720p.BR.vk007.mkv',
  'Justice.League.Unlimited.S01E01.1080p.BluRay.10Bit.H265-d3g.mkv',
  'Malcolm in the Middle S04E01 720p Netflix WEB-DL DD 5.1 H.264-AJP69.mkv',
  'Marvels.Avengers.Assemble.S01E01.1080p.WEB-DL.DD5.1.AAC2.0.H264-BgFr.mkv',
  "Marvel's Avengers Black Panther's Quest S05E01 Shadow of Atlantis (1).mkv",
  'Teenage.Mutant.Ninja.Turtles.2012.S01E01.Rise.of.the.Turtles,Pt.1.720p.WEB-DL.x264.AAC.mp4',
  'The.Avengers.Earths.Mightiest.Heroes.S01E01.Breakout.1.1080p.DTS-HD.MA.5.1.AVC.REMUX-FraMeSToR.mkv',
  'The.Batman.S01E08.Q&A.NF.WEB-DL.DD+2.0.H.264-CtrlHD.mkv',
  'The.Super.Hero.Squad.S02E01-HD.720 p.WEB-DL.AAC2.0.H2 64-PYROGABB.mkv',
  'Superman.The.Animated.Series.S01E01.TheLast.Son.of.Krypton.(1).DVDRip.x264-CtrlSD.mkv',
  'X-Men 97 (2024) S01E01 (1080p DSNP WEB-DL H265 SDR DDP Atmos 5.1 English - HONE).mkv',
  'x-men_-_1x01_-_night_of_the_sentinels_-_part_1_[vpc].avi',
  'Young Justice - 101 & 102 - Independence Day {C_P}.avi',
  'Young Justice - 103 - Welcome to Happy Harbor {C_P}.avi',
];

const MOVIES = [
  'Ballerina (2025)',
  'Anniversary.2025.1080p.WEB.H264-SLOT',
  'Batman Mask of the Phantasm 1993 1080p MAX WEB-DL DDP5 1 H 264 2Audio-HDSWEB',
  'Batman v Superman Dawn of Justice 2016',
  'Captain America Brave New World (2025) 1080p BluRay 5.1-LAMA',
  'Fantastic Four First Steps 2025',
  'K-Pop Demon Hunters',
  'Kingdom Of The Planet Of The Apes (2024) 1080p BluRay 5.1-LAMA',
  'Man of Steel 2013 X265',
  'Mercy 2026 1080p WEB-DL HEVC x265 10Bit DDP5 1 Subs KINGDOM',
  'Superman Batman Public Enemies 2009 2160p WEB-DL DD5 1 DV HDR H 265-FLUX',
  'The Legend Of Aang The Last Airbender (2026) 1080p WEBRip-LAMA',
  'The Rip 2026 1080p NF WEB-DL x264 DDP 5 1 Atmos-CMCTV',
  'Zack Snyders Justice League (2021)',
  'Rebel.Moon.Part.One.2023.DC.1080p.WEBRip.DDP5.1.x265.10bit-LAMA.mkv',
  'Watchmen Chapter I 2024 1080p 10bit WEBRip 6CH X265 HEVC-PSA',
  'Ballerina.2025.1080p.WEBRip.x265.10bit.AAC5.1-LAMA.mp4',
];

const FOLDERS = [
  'Season 1', 'SEAOSN 1', 'SEASON 2', 'X-Men TAS [HQ] Season 1 [vpc]',
  'The.Batman.S01.NF.WEB-DL.DD+2.0.x264-CtrlSD',
  'Malcolm.in.the.Middle.S01.720p.Netflix.WEB-DL.DD5.1.x264-QOQ',
  'Justice League S01', 'Ben.10.Alien.Force.S02.1080p.WEB-DL.AAC2.0.H.264-iT00NZ',
  'Ben.10.Alien.Force.S01-S03.1080p.WEB-DL.AAC2.0.H.264-iT00NZ',
  'Teenage.Mutant.Ninja.Turtles.2012.S01+S02',
  'Justice League All Seasons 1 2 3 4 5 Complete 720p MKV vk007  LOW QUALITY',
  'X-Men TAS [HQ] Season 1-5',
  'Justice League Unlimited S01-S03 br 10bit hevc-d3g',
];

const pad = (s, n) => String(s).padEnd(n);

console.log('='.repeat(110));
console.log('EPISODES');
console.log('='.repeat(110));
for (const f of EPISODES) {
  const r = parseEpisodeFile(f);
  if (!r) { console.log(`  !! NO MATCH  ${f}`); continue; }
  const se = `S${String(r.season ?? 0).padStart(2, '0')}E${String(r.episode).padStart(2, '0')}${r.episodeEnd ? `-E${String(r.episodeEnd).padStart(2, '0')}` : ''}`;
  console.log(`  ${pad(r.seriesTitle, 34)} ${pad(se, 11)} ${pad(r.pattern, 15)} ${r.episodeTitle ?? '-'}`);
}

console.log('\n' + '='.repeat(110));
console.log('MOVIES / TITLES');
console.log('='.repeat(110));
for (const f of MOVIES) {
  const isFile = /\.\w{2,4}$/.test(f);
  const r = parseTitle(f, { isFile });
  console.log(`  ${pad(r.title, 42)} ${pad(r.year ?? '-', 6)}  <- ${f}`);
}

console.log('\n' + '='.repeat(110));
console.log('FOLDERS (season number / season range)');
console.log('='.repeat(110));
for (const f of FOLDERS) {
  const s = parseSeasonFolder(f);
  const range = parseSeasonRange(f);
  console.log(`  season=${pad(s ?? '-', 5)} range=${pad(range ? range.join('-') : '-', 8)}  ${f}`);
}

console.log('\n' + '='.repeat(110));
console.log('SERIES GROUPING KEYS (folders that should collapse together)');
console.log('='.repeat(110));
const GROUPS = [
  'Ben 10 2005 S01 1080p Max WEB-DL AAC2 0 H 264-RegEdits',
  'Ben 10 2005 S02 1080p Max WEB-DL AAC2 0 H 264-RegEdits',
  'Ben 10 S04 1080p WEB-DL AAC2 0 H 264-SA89',
  'Ben.10.Alien.Force.S01-S03.1080p.WEB-DL.AAC2.0.H.264-iT00NZ',
  'Invincible 2021 S01 1080p AMZN WEB-DL H 264 DDP5 1-PTerWEB',
  'Invincible 2025 S03 Complete 1080p AMZN WEB-DL H 264 DDP5 1-UBWEB',
  'Teenage.Mutant.Ninja.Turtles.2012.S01+S02',
  'Teenage.Mutant.Ninja.Turtles.2012.S03.1080p.WEB-DL.AAC2.0.H.264-iT00NZ',
  'Marvels Avengers Assemble S01 1080p WEB-DL DD5 1 AAC2 0 H264-BgFr',
  "Marvels Avengers Assemble Season 5 Complete Black Panther's Quest 720p WEB-DL x264 [i_c]",
];
for (const f of GROUPS) {
  const withoutSeason = f.replace(/\bS\d{1,2}([-+]S?\d{1,2})?\b/gi, ' ').replace(/\bseasons?\s*\d+\b/gi, ' ');
  const t = parseTitle(withoutSeason);
  console.log(`  key="${pad(seriesKey(t.title), 30)}" year=${pad(t.year ?? '-', 6)} <- ${f}`);
}
