#!/usr/bin/env node
/**
 * Jobe Positioning PPTX Generator
 * Generates a 5-slide positioning deck from a report JSON.
 * Usage: node scripts/render-pptx.js reports/jobe-2026-04-10-stripe-senior-ml-engineer.json
 */

const pptxgen = require('pptxgenjs');
const fs = require('fs');
const path = require('path');

const COLORS = {
  navy: '1B2A4A',
  darkNavy: '111D35',
  iceBlue: 'C7D2E8',
  white: 'FFFFFF',
  offWhite: 'F4F6FC',
  charcoal: '1A1A2E',
  slate: '64748B',
  lightGray: 'E2E8F0',
  red: 'DC2626',
  amber: 'D97706',
  green: '059669',
  teal: '0D9488'
};

const FONTS = { title: 'Georgia', body: 'Calibri', mono: 'Consolas' };

const makeShadow = () => ({
  type: 'outer', blur: 8, offset: 2, angle: 135, color: '000000', opacity: 0.1
});

function buildSlide1_Title(pres, data) {
  const slide = pres.addSlide();
  slide.background = { color: COLORS.darkNavy };

  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.06, fill: { color: COLORS.teal }
  });

  slide.addText((data.candidateName || 'CANDIDATE').toUpperCase(), {
    x: 0.8, y: 0.5, w: 8.4, h: 0.6,
    fontFace: FONTS.title, fontSize: 32, bold: true,
    color: COLORS.white, charSpacing: 4
  });

  slide.addText(`${data.company} | ${data.role}`, {
    x: 0.8, y: 1.1, w: 8.4, h: 0.4,
    fontFace: FONTS.body, fontSize: 16, color: COLORS.iceBlue
  });

  // Match score badge
  const scoreColor = data.overallScore >= 85 ? COLORS.green
    : data.overallScore >= 70 ? COLORS.teal
    : data.overallScore >= 55 ? COLORS.amber : COLORS.red;

  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.8, y: 1.75, w: 1.6, h: 0.6,
    fill: { color: scoreColor }, rectRadius: 0.1
  });
  slide.addText(`${data.overallScore}%`, {
    x: 0.8, y: 1.75, w: 1.6, h: 0.6,
    fontFace: FONTS.body, fontSize: 22, bold: true,
    color: COLORS.white, align: 'center', valign: 'middle'
  });

  slide.addShape(pres.shapes.LINE, {
    x: 0.8, y: 2.6, w: 3, h: 0,
    line: { color: COLORS.iceBlue, width: 2 }
  });

  // Top differentiators
  const diffs = (data.topDifferentiators || []).slice(0, 3);
  diffs.forEach((diff, i) => {
    const y = 2.9 + (i * 0.75);

    slide.addShape(pres.shapes.OVAL, {
      x: 0.8, y, w: 0.35, h: 0.35,
      fill: { color: COLORS.teal }
    });
    slide.addText(String(i + 1), {
      x: 0.8, y, w: 0.35, h: 0.35,
      fontFace: FONTS.body, fontSize: 12, bold: true,
      color: COLORS.white, align: 'center', valign: 'middle'
    });
    slide.addText(diff, {
      x: 1.35, y: y - 0.02, w: 7.8, h: 0.65,
      fontFace: FONTS.body, fontSize: 12, color: COLORS.white,
      lineSpacingMultiple: 1.2, valign: 'top'
    });
  });

  slide.addText(`Competitive Positioning Report | ${data.date}`, {
    x: 0.8, y: 5.05, w: 8.4, h: 0.35,
    fontFace: FONTS.body, fontSize: 9, color: COLORS.slate
  });
}

function buildSlide2_Scores(pres, data) {
  const slide = pres.addSlide();
  slide.background = { color: COLORS.offWhite };

  slide.addText('REQUIREMENT MAPPING', {
    x: 0.6, y: 0.3, w: 8.8, h: 0.5,
    fontFace: FONTS.title, fontSize: 22, bold: true, color: COLORS.navy
  });

  const scores = data.categoryScores || {};
  const categories = Object.entries(scores).slice(0, 7);

  if (categories.length > 0) {
    slide.addChart(pres.charts.BAR, [{
      name: 'Match Score',
      labels: categories.map(([k]) => k.replace(/([A-Z])/g, ' $1').trim()),
      values: categories.map(([, v]) => v.score || 0)
    }], {
      x: 0.4, y: 1.0, w: 5.0, h: 3.6,
      barDir: 'bar',
      chartColors: [COLORS.teal],
      chartArea: { fill: { color: COLORS.white }, roundedCorners: true },
      catAxisLabelColor: COLORS.charcoal, catAxisLabelFontSize: 9,
      valAxisLabelColor: COLORS.slate, valAxisLabelFontSize: 8,
      valAxisMaxVal: 100,
      valGridLine: { color: COLORS.lightGray, size: 0.5 },
      catGridLine: { style: 'none' },
      showValue: true, dataLabelPosition: 'outEnd', dataLabelColor: COLORS.charcoal,
      dataLabelFontSize: 9, showLegend: false,
      shadow: makeShadow()
    });
  }

  // Top matches panel
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 5.7, y: 1.0, w: 4.0, h: 3.6,
    fill: { color: COLORS.white }, shadow: makeShadow()
  });

  slide.addText('TOP MATCHES', {
    x: 5.95, y: 1.15, w: 3.5, h: 0.35,
    fontFace: FONTS.body, fontSize: 12, bold: true, color: COLORS.green
  });

  const matches = (data.topMatches || data.topDifferentiators || []).slice(0, 5);
  const matchText = matches.map(m => [{
    text: typeof m === 'string' ? m : (m.requirement || ''),
    options: { bullet: true, breakLine: true, fontSize: 10, color: COLORS.charcoal }
  }]).flat();

  if (matchText.length > 0) {
    slide.addText(matchText, {
      x: 5.95, y: 1.6, w: 3.5, h: 2.8,
      fontFace: FONTS.body, valign: 'top', lineSpacingMultiple: 1.3
    });
  }
}

function buildSlide3_Competitive(pres, data) {
  const slide = pres.addSlide();
  slide.background = { color: COLORS.white };

  slide.addText('COMPETITIVE POSITIONING', {
    x: 0.6, y: 0.3, w: 8.8, h: 0.5,
    fontFace: FONTS.title, fontSize: 22, bold: true, color: COLORS.navy
  });

  // Typical applicant (left)
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.4, y: 0.95, w: 4.5, h: 3.8,
    fill: { color: COLORS.offWhite }, shadow: makeShadow()
  });

  slide.addText('TYPICAL APPLICANT', {
    x: 0.65, y: 1.05, w: 4.0, h: 0.35,
    fontFace: FONTS.body, fontSize: 12, bold: true, color: COLORS.slate
  });

  const comp = data.competitorProfile || {};
  const compText = (comp.typicalBackground || 'MS/PhD from top program, 3-5 years at known tech company, deep specialization in one ML domain')
    .split('. ').map(s => [{
      text: s.trim() + (s.endsWith('.') ? '' : '.'),
      options: { bullet: true, breakLine: true, fontSize: 10, color: COLORS.charcoal }
    }]).flat();

  slide.addText(compText, {
    x: 0.65, y: 1.5, w: 4.0, h: 3.0,
    fontFace: FONTS.body, valign: 'top', lineSpacingMultiple: 1.3
  });

  // the candidate's edge (right)
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 5.1, y: 0.95, w: 4.5, h: 3.8,
    fill: { color: COLORS.white }, shadow: makeShadow()
  });

  slide.addShape(pres.shapes.RECTANGLE, {
    x: 5.1, y: 0.95, w: 4.5, h: 0.06,
    fill: { color: COLORS.teal }
  });

  slide.addText('YOUR EDGE', {
    x: 5.35, y: 1.1, w: 4.0, h: 0.35,
    fontFace: FONTS.body, fontSize: 12, bold: true, color: COLORS.teal
  });

  const diffs = (data.topDifferentiators || []).slice(0, 5);
  const diffText = diffs.map(d => [{
    text: typeof d === 'string' ? d : (d.text || ''),
    options: { bullet: true, breakLine: true, fontSize: 10, color: COLORS.charcoal }
  }]).flat();

  if (diffText.length > 0) {
    slide.addText(diffText, {
      x: 5.35, y: 1.55, w: 4.0, h: 3.0,
      fontFace: FONTS.body, valign: 'top', lineSpacingMultiple: 1.3
    });
  }
}

function buildSlide4_GapsMitigation(pres, data) {
  const slide = pres.addSlide();
  slide.background = { color: COLORS.offWhite };

  slide.addText('STRENGTHS & GAP MITIGATION', {
    x: 0.6, y: 0.3, w: 8.8, h: 0.5,
    fontFace: FONTS.title, fontSize: 22, bold: true, color: COLORS.navy
  });

  const columns = [
    { title: 'STRENGTHS', color: COLORS.green, items: (data.topDifferentiators || []).slice(0, 4) },
    { title: 'ADJACENCIES', color: COLORS.teal, items: (data.adjacencies || []).slice(0, 4) },
    { title: 'GAPS + MITIGATION', color: COLORS.amber, items: (data.gaps || []).slice(0, 4) }
  ];

  columns.forEach((col, i) => {
    const x = 0.4 + (i * 3.15);

    slide.addShape(pres.shapes.RECTANGLE, {
      x, y: 0.95, w: 3.0, h: 4.0,
      fill: { color: COLORS.white }, shadow: makeShadow()
    });

    slide.addShape(pres.shapes.RECTANGLE, {
      x, y: 0.95, w: 3.0, h: 0.06,
      fill: { color: col.color }
    });

    slide.addText(col.title, {
      x: x + 0.2, y: 1.15, w: 2.6, h: 0.3,
      fontFace: FONTS.body, fontSize: 13, bold: true, color: col.color
    });

    const itemText = col.items.map(item => [{
      text: typeof item === 'string' ? item : (item.requirement || item.mitigation || item.text || ''),
      options: { bullet: true, breakLine: true, fontSize: 10, color: COLORS.charcoal }
    }]).flat();

    if (itemText.length > 0) {
      slide.addText(itemText, {
        x: x + 0.2, y: 1.55, w: 2.6, h: 3.2,
        fontFace: FONTS.body, valign: 'top', lineSpacingMultiple: 1.3
      });
    }
  });
}

function buildSlide5_TalkingPoints(pres, data) {
  const slide = pres.addSlide();
  slide.background = { color: COLORS.darkNavy };

  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.06, fill: { color: COLORS.teal }
  });

  slide.addText('KEY INTERVIEW TALKING POINTS', {
    x: 0.8, y: 0.35, w: 8.4, h: 0.5,
    fontFace: FONTS.title, fontSize: 22, bold: true, color: COLORS.white
  });

  const points = (data.talkingPoints || []).slice(0, 5);
  points.forEach((point, i) => {
    const y = 1.1 + (i * 0.8);

    slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: 0.6, y, w: 8.8, h: 0.65,
      fill: { color: COLORS.navy }, rectRadius: 0.08
    });

    const req = typeof point === 'string' ? point : (point.requirement || '');
    const proj = typeof point === 'string' ? '' : (point.project || '');
    const metric = typeof point === 'string' ? '' : (point.metric || '');

    slide.addText(req, {
      x: 0.85, y: y + 0.05, w: 4.0, h: 0.25,
      fontFace: FONTS.body, fontSize: 11, bold: true, color: COLORS.white
    });

    if (proj || metric) {
      slide.addText(`${proj}${metric ? ' — ' + metric : ''}`, {
        x: 0.85, y: y + 0.3, w: 8.3, h: 0.25,
        fontFace: FONTS.body, fontSize: 9, color: COLORS.iceBlue
      });
    }
  });

  slide.addText(`Competitive Positioning | ${data.candidateName || 'Candidate'} | ${data.date}`, {
    x: 0.8, y: 5.05, w: 8.4, h: 0.3,
    fontFace: FONTS.body, fontSize: 9, color: COLORS.slate
  });
}

async function generate(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const outputPath = inputPath.replace(/\.json$/, '.pptx');

  const pres = new pptxgen();
  pres.layout = 'LAYOUT_16x9';
  pres.author = 'Jobe Positioning Intelligence';
  pres.title = `${data.company} — ${data.role} — Positioning Report`;

  buildSlide1_Title(pres, data);
  buildSlide2_Scores(pres, data);
  buildSlide3_Competitive(pres, data);
  buildSlide4_GapsMitigation(pres, data);
  buildSlide5_TalkingPoints(pres, data);

  await pres.writeFile({ fileName: outputPath });
  console.log(`PPTX saved: ${outputPath}`);
  return outputPath;
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/render-pptx.js <report-data.json>');
  process.exit(1);
}

generate(path.resolve(input)).catch(err => {
  console.error('PPTX generation failed:', err.message);
  process.exit(1);
});
