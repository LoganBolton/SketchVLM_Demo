import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".svg"];

export async function GET() {
  const samplesDir = path.join(process.cwd(), "public", "samples");

  let files: string[];
  try {
    files = fs.readdirSync(samplesDir);
  } catch {
    return NextResponse.json([]);
  }

  const images = files.filter((f) =>
    IMAGE_EXTS.includes(path.extname(f).toLowerCase())
  );

  const samples = images.map((imgFile) => {
    const id = path.basename(imgFile, path.extname(imgFile));
    const txtPath = path.join(samplesDir, `${id}.txt`);

    let prompt = "";
    try {
      prompt = fs.readFileSync(txtPath, "utf-8").trim();
    } catch {
      // no prompt file — prompt stays empty
    }

    // "bar-chart" → "Bar Chart"
    const label = id
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    return { id, label, imagePath: `/samples/${imgFile}`, prompt };
  });

  return NextResponse.json(samples);
}
