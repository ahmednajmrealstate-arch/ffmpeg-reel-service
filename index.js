process.on('uncaughtException', function(err) {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  process.exit(1);
});

var express = require("express");
var ffmpeg = require("fluent-ffmpeg");
var axios = require("axios");
var fs = require("fs");
var path = require("path");
var google = require("googleapis").google;

var app = express();
app.use(express.json({ limit: "50mb" }));

var PORT = process.env.PORT || 3000;
var DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
var serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

function getDriveClient() {
  var auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return google.drive({ version: "v3", auth: auth });
}

function downloadFile(url, destPath) {
  return axios.get(url, { responseType: "stream" }).then(function(response) {
    return new Promise(function(resolve, reject) {
      var writer = fs.createWriteStream(destPath);
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  });
}

function uploadToDrive(filePath, fileName) {
  var drive = getDriveClient();
  var fileMetadata = {
    name: fileName,
    parents: [DRIVE_FOLDER_ID],
  };
  var media = {
    mimeType: "video/mp4",
    body: fs.createReadStream(filePath),
  };
  return drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: "id",
  }).then(function(response) {
    var fileId = response.data.id;
    return drive.permissions.create({
      fileId: fileId,
      resource: { role: "reader", type: "anyone" },
    }).then(function() {
      var publicUrl = "https://drive.google.com/uc?export=download&id=" + fileId;
      return { fileId: fileId, url: publicUrl };
    });
  });
}

function cleanup() {
  var files = Array.prototype.slice.call(arguments);
  files.forEach(function(f) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
}

app.get("/health", function(req, res) {
  res.json({ status: "ok", message: "FFmpeg Reel Service Running" });
});

app.post("/generate-reel", function(req, res) {
  var property_id = req.body.property_id;
  var title = req.body.title;
  var location = req.body.location;
  var price = req.body.price;
  var price_unit = req.body.price_unit;
  var bedrooms = req.body.bedrooms;
  var area_sqm = req.body.area_sqm;
  var hook_text = req.body.hook_text;
  var cta_text = req.body.cta_text;
  var image_url = req.body.image_url;
  var secret_key = req.body.secret_key;

  if (secret_key !== process.env.SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!image_url || !property_id) {
    return res.status(400).json({ error: "Missing image_url or property_id" });
  }

  var imageUrls = image_url.split(",").map(function(u) {
    return u.trim();
  }).filter(function(u) {
    return u.length > 0;
  });

  var tmpDir = "/tmp";
  var imagePaths = [];
  var outputPath = path.join(tmpDir, property_id + "_reel.mp4");
  var fileName = "reel_" + property_id + "_" + Date.now() + ".mp4";

  var downloadPromises = imageUrls.map(function(url, i) {
    var imgPath = path.join(tmpDir, property_id + "_img_" + i + ".jpg");
    imagePaths.push(imgPath);
    return downloadFile(url, imgPath);
  });

  Promise.all(downloadPromises).then(function() {
    var totalDuration = 30;
    var durationPerImage = Math.floor(totalDuration / imagePaths.length);

    return new Promise(function(resolve, reject) {
      var cmd = ffmpeg();

      imagePaths.forEach(function(imgPath) {
        cmd = cmd.input(imgPath).inputOptions([
          "-loop 1",
          "-t " + durationPerImage,
          "-framerate 25"
        ]);
      });

      var scaleFilters = imagePaths.map(function(_, i) {
        return "[" + i + ":v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v" + i + "]";
      });

      var concatInput = imagePaths.map(function(_, i) {
        return "[v" + i + "]";
      }).join("");

      var concatFilter = concatInput + "concat=n=" + imagePaths.length + ":v=1:a=0[outv]";

      var safeHook = (hook_text || title || "").replace(/'/g, "").substring(0, 60);
      var safeLocation = (location || "").replace(/'/g, "").substring(0, 40);
      var safePrice = (price || "") + " " + (price_unit || "");
      var safeDetails = (bedrooms || "") + " " + (area_sqm || "");
      var safeCta = (cta_text || "").replace(/'/g, "").substring(0, 50);

      var hookFilter = "[outv]drawtext=text='" + safeHook + "':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=180:shadowcolor=black:shadowx=3:shadowy=3[v_hook]";
      var locFilter = "[v_hook]drawtext=text='" + safeLocation + "':fontsize=38:fontcolor=white:x=(w-text_w)/2:y=1350:shadowcolor=black:shadowx=2:shadowy=2[v_loc]";
      var priceFilter = "[v_loc]drawtext=text='" + safePrice + "':fontsize=44:fontcolor=yellow:x=(w-text_w)/2:y=1430:shadowcolor=black:shadowx=2:shadowy=2[v_price]";
      var detailFilter = "[v_price]drawtext=text='" + safeDetails + "':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=1510:shadowcolor=black:shadowx=2:shadowy=2[v_det]";
      var ctaFilter = "[v_det]drawtext=text='" + safeCta + "':fontsize=42:fontcolor=white:box=1:boxcolor=green@0.85:boxborderw=20:x=(w-text_w)/2:y=1700[final]";

      cmd.input("anullsrc=r=44100:cl=stereo")
        .inputOptions(["-t 30"])
        .complexFilter([
          scaleFilters.join(";"),
          concatFilter,
          hookFilter,
          locFilter,
          priceFilter,
          detailFilter,
          ctaFilter
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
          "-b:a 128k"
        ])
        .output(outputPath)
        .on("start", function() {
          console.log("FFmpeg started for " + property_id);
        })
        .on("progress", function(p) {
          console.log("Progress: " + Math.round(p.percent || 0) + "%");
        })
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

  }).then(function() {
    console.log("Uploading to Drive...");
    return uploadToDrive(outputPath, fileName);

  }).then(function(result) {
    cleanup.apply(null, imagePaths.concat([outputPath]));
    console.log("Done. URL: " + result.url);
    res.json({
      success: true,
      property_id: property_id,
      video_url: result.url,
      drive_file_id: result.fileId,
      file_name: fileName
    });

  }).catch(function(error) {
    cleanup.apply(null, imagePaths.concat([outputPath]));
    console.error("Error: " + error.message);
    res.status(500).json({
      success: false,
      property_id: property_id,
      error: error.message
    });
  });
});

app.listen(PORT, function() {
  console.log("FFmpeg Reel Service running on port " + PORT);
});

