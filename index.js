process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const GOOGLE_SERVICE_ACCOUNT = JSON.parse(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON
);
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// Google Drive Auth
function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_SERVICE_ACCOUNT,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return google.drive({ version: "v3", auth });
}

// Download file from URL
async function downloadFile(url, destPath) {
  const response = await axios.get(url, { responseType: "stream" });
  const writer = fs.createWriteStream(destPath);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

// Upload to Google Drive
async function uploadToDrive(filePath, fileName) {
  const drive = getDriveClient();
  const fileMetadata = {
    name: fileName,
    parents: [DRIVE_FOLDER_ID],
  };
  const media = {
    mimeType: "video/mp4",
    body: fs.createReadStream(filePath),
  };
  const response = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: "id, webViewLink, webContentLink",
  });
  await drive.permissions.create({
    fileId: response.data.id,
    resource: { role: "reader", type: "anyone" },
  });
  const publicUrl = https://drive.google.com/uc?export=download&id=${response.data.id};
  return { fileId: response.data.id, url: publicUrl };
}

// Cleanup temp files
function cleanup(...files) {
  files.forEach((f) => {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "FFmpeg Reel Service Running" });
});

// Main Reel Generation Endpoint
app.post("/generate-reel", async (req, res) => {
  const {
    property_id,
    title,
    location,
    price,
    price_unit,
    bedrooms,
    area_sqm,
    hook_text,
    cta_text,
    image_url,
    secret_key,
  } = req.body;

  // Auth check
  if (secret_key !== process.env.SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Validate required fields
  if (!image_url || !property_id) {
    return res.status(400).json({
      error: "Missing image_url or property_id",
    });
  }

  // Parse comma separated image URLs
  const imageUrls = image_url
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  const tmpDir = "/tmp";
  const imagePaths = [];
  const outputPath = path.join(tmpDir, ${property_id}_reel.mp4);
  const fileName = reel_${property_id}_${Date.now()}.mp4;

  try {
    // Download all images
    console.log([${property_id}] Downloading ${imageUrls.length} images...);
    for (let i = 0; i < imageUrls.length; i++) {
      const imgPath = path.join(tmpDir, ${property_id}_img_${i}.jpg);
      await downloadFile(imageUrls[i], imgPath);
      imagePaths.push(imgPath);
    }

    // Calculate duration per image
    const totalDuration = 30;
    const durationPerImage = Math.floor(totalDuration / imagePaths.length);

    console.log([${property_id}] Running FFmpeg...);

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg();

      // Add each image as input
      imagePaths.forEach((imgPath) => {
        cmd = cmd
          .input(imgPath)
          .inputOptions([
            "-loop 1",
            -t ${durationPerImage},
            "-framerate 25",
          ]);
      });

      // Build filter complex
      const scaleFilters = imagePaths.map((_, i) =>
          [${i}:v]scale=1080:1920:force_original_aspect_ratio=increase, +
          crop=1080:1920,setsar=1, +
          zoompan=z='min(zoom+0.0008,1.3)':d=${durationPerImage * 25}: +
          x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920[v${i}]
      );

      const concatInput = imagePaths.map((_, i) => [v${i}]).join("");
      const concatFilter = ${concatInput}concat=n=${imagePaths.length}:v=1:a=0[outv];

      const hookFilter =
        [outv]drawtext= +
        text='${(hook_text || title || "").replace(/'/g, "").substring(0, 60)}': +
        fontsize=52:fontcolor=white: +
        x=(w-text_w)/2:y=180: +
        shadowcolor=black:shadowx=3:shadowy=3[v_hook];

      const locationFilter =
        [v_hook]drawtext= +
        text='${(location || "").replace(/'/g, "").substring(0, 40)}': +
        fontsize=38:fontcolor=white: +
        x=(w-text_w)/2:y=1350: +
        shadowcolor=black:shadowx=2:shadowy=2[v_loc];

      const priceFilter =
        [v_loc]drawtext= +
        text='${price || ""} ${price_unit || ""}': +
        fontsize=44:fontcolor=yellow: +
        x=(w-text_w)/2:y=1430: +
        shadowcolor=black:shadowx=2:shadowy=2[v_price];

      const detailsFilter =
        [v_price]drawtext= +
        text='${bedrooms || ""} غرف | ${area_sqm || ""} متر': +
        fontsize=36:fontcolor=white: +
        x=(w-text_w)/2:y=1510: +
        shadowcolor=black:shadowx=2:shadowy=2[v_details];

      const ctaFilter =
        [v_details]drawtext= +
        text='${(cta_text || "ابعتلنا واتساب دلوقتي").replace(/'/g, "").substring(0, 50)}': +
        fontsize=42:fontcolor=white: +
        box=1:boxcolor=green@0.85:boxborderw=20: +
        x=(w-text_w)/2:y=1700[final];

      cmd
        .input("anullsrc=r=44100:cl=stereo")
        .inputOptions(["-t 30"])
        .complexFilter([
          ...scaleFilters,
          concatFilter,
          hookFilter,
          locationFilter,
          priceFilter,
          detailsFilter,
          ctaFilter,
        ])
        .outputOptions([
          "-map [final]",
          "-map " + imagePaths.length + ":a",
          "-pix_fmt yuv420p",
          "-preset fast",
          "-crf 23",
          "-movflags +faststart",
          "-shortest",
          "-c:v libx264",
          "-c:a aac",
          "-b:a 128k",
        ])
        .output(outputPath)
        .on("start", (cmd) =>
          console.log([${property_id}] FFmpeg started)
        )
        .on("progress", (p) =>
          console.log(
            [${property_id}] Progress: ${Math.round(p.percent || 0)}%
          )
        )
        .on("end", () => {
          console.log([${property_id}] FFmpeg complete);
          resolve();
        })
        .on("error", (err) => {
          console.error([${property_id}] FFmpeg error: ${err.message});
          reject(err);
        })
        .run();
    });

    console.log([${property_id}] Uploading to Drive...);
    const { fileId, url } = await uploadToDrive(outputPath, fileName);

    cleanup(...imagePaths, outputPath);

    console.log([${property_id}] Done. URL: ${url});
    res.json({
      success: true,
      property_id,
      video_url: url,
      drive_file_id: fileId,
      file_name: fileName,
    });
  } catch (error) {
    cleanup(...imagePaths, outputPath);
    console.error([${property_id}] Fatal error: ${error.message});
    res.status(500).json({
      success: false,
      property_id,
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(FFmpeg Reel Service running on port ${PORT});
});
