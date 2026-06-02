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
var CLOUDINARY_CLOUD = process.env.CLOUDINARY_CLOUD_NAME || "dqyjxb7si";

function getMusicByEmotion(emotion) {
  var musicMap = {
    "family":  process.env.MUSIC_URL_FAMILY,
    "luxury":  process.env.MUSIC_URL_LUXURY,
    "urgent":  process.env.MUSIC_URL_URGENT,
    "budget":  process.env.MUSIC_URL_BUDGET,
    "default": process.env.MUSIC_URL_DEFAULT
  };
  var selected = musicMap[emotion] || musicMap["default"] || "";
  console.log("Emotion: " + emotion + " | Music: " + (selected ? "found" : "none"));
  return selected || "";
}

function toCloudinaryUrl(url) {
  url = url.trim();
  if (url.indexOf("cloudinary.com") > -1) return url;
  return "https://res.cloudinary.com/" + CLOUDINARY_CLOUD + "/image/fetch/" + encodeURIComponent(url);
}

function getDriveClient() {
  var auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return google.drive({ version: "v3", auth: auth });
}

function downloadImage(url, destPath) {
  var fetchUrl = toCloudinaryUrl(url);
  console.log("Downloading image...");
  return axios.get(fetchUrl, {
    responseType: "stream",
    timeout: 45000,
    maxRedirects: 10,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "image/*,*/*"
    }
  }).then(function(response) {
    return new Promise(function(resolve, reject) {
      var writer = fs.createWriteStream(destPath);
      response.data.pipe(writer);
      writer.on("finish", function() {
        var size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
        if (size > 1000) {
          console.log("Image OK: " + size + " bytes");
          resolve();
        } else {
          reject(new Error("Image too small: " + size));
        }
      });
      writer.on("error", reject);
    });
  });
}

function downloadMusic(url, destPath) {
  return axios.get(url, {
    responseType: "stream",
    timeout: 60000,
    maxRedirects: 10,
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "audio/*,*/*" }
  }).then(function(response) {
    return new Promise(function(resolve) {
      var writer = fs.createWriteStream(destPath);
      response.data.pipe(writer);
      writer.on("finish", function() {
        var size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
        if (size > 10000) {
          console.log("Music OK: " + size + " bytes");
          resolve(true);
        } else {
          console.log("Music too small, skipping");
          resolve(false);
        }
      });
      writer.on("error", function() { resolve(false); });
    });
  }).catch(function(err) {
    console.log("Music failed: " + err.message);
    return false;
  });
}

function uploadToDrive(filePath, fileName) {
  var drive = getDriveClient();
  return drive.files.create({
    resource: { name: fileName, parents: [DRIVE_FOLDER_ID] },
    media: { mimeType: "video/mp4", body: fs.createReadStream(filePath) },
    fields: "id",
  }).then(function(response) {
    var fileId = response.data.id;
    return drive.permissions.create({
      fileId: fileId,
      resource: { role: "reader", type: "anyone" },
    }).then(function() {
      return {
        fileId: fileId,
        url: "https://drive.google.com/uc?export=download&id=" + fileId
      };
    });
  });
}

function cleanup() {
  Array.prototype.slice.call(arguments).forEach(function(f) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {}
  });
}

// Normalize single image to fixed size using FFmpeg
function normalizeImage(inputPath, outputPath) {
  return new Promise(function(resolve, reject) {
    ffmpeg(inputPath)
      .videoFilter([
        "scale=1920:1920:force_original_aspect_ratio=increase",
        "crop=1920:1920",
        "scale=1080:1080",
        "format=yuv420p"
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

app.get("/health", function(req, res) {
  res.json({
    status: "ok",
    message: "FFmpeg Reel Service - Fixed Dimensions Version",
    cloudinary_cloud: CLOUDINARY_CLOUD,
    music_family:  process.env.MUSIC_URL_FAMILY  ? "configured" : "missing",
    music_luxury:  process.env.MUSIC_URL_LUXURY  ? "configured" : "missing",
    music_urgent:  process.env.MUSIC_URL_URGENT  ? "configured" : "missing",
    music_budget:  process.env.MUSIC_URL_BUDGET  ? "configured" : "missing",
    music_default: process.env.MUSIC_URL_DEFAULT ? "configured" : "missing"
  });
});

app.post("/generate-reel", function(req, res) {
  var property_id = req.body.property_id;
  var title       = req.body.title;
  var location    = req.body.location;
  var price       = req.body.price;
  var price_unit  = req.body.price_unit;
  var bedrooms    = req.body.bedrooms;
  var area_sqm    = req.body.area_sqm;
  var hook_text   = req.body.hook_text;
  var cta_text    = req.body.cta_text;
  var key_benefit = req.body.key_benefit || "";
  var emotion     = req.body.emotion || "default";
  var image_url   = req.body.image_url;
  var secret_key  = req.body.secret_key;

  if (secret_key !== process.env.SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!image_url || !property_id) {
    return res.status(400).json({ error: "Missing image_url or property_id" });
  }

  var music_url = getMusicByEmotion(emotion);

  var imageUrls = image_url.split(",").map(function(u) {
    return u.trim();
  }).filter(function(u) { return u.length > 0; });

  var tmpDir = "/tmp";
  var rawImagePaths = [];
  var normalizedPaths = [];
  var musicPath = path.join(tmpDir, property_id + "_music.mp3");
  var outputPath = path.join(tmpDir, property_id + "_reel.mp4");
  var fileName = "reel_" + property_id + "_" + Date.now() + ".mp4";
  var musicLoaded = false;

  // Step 1: Download all images
  var imagePromises = imageUrls.map(function(url, i) {
    var rawPath = path.join(tmpDir, property_id + "_raw_" + i + ".jpg");
    rawImagePaths.push(rawPath);
    return downloadImage(url, rawPath);
  });

  Promise.all(imagePromises).then(function() {
    console.log("All " + rawImagePaths.length + " images downloaded");

    // Step 2: Normalize all images to same format
    var normalizePromises = rawImagePaths.map(function(rawPath, i) {
      var normPath = path.join(tmpDir, property_id + "_norm_" + i + ".jpg");
      normalizedPaths.push(normPath);
      return normalizeImage(rawPath, normPath).then(function() {
        console.log("Image " + i + " normalized");
      }).catch(function(err) {
        // If normalization fails, use raw image
        console.log("Normalization failed for image " + i + ", using raw: " + err.message);
        normalizedPaths[i] = rawPath;
      });
    });

    return Promise.all(normalizePromises);

  }).then(function() {
    // Step 3: Download music
    if (music_url) {
      return downloadMusic(music_url, musicPath).then(function(success) {
        musicLoaded = success;
      });
    }

  }).then(function() {
    var numImages = normalizedPaths.length;
    var durationPerImage = Math.max(5, Math.floor(30 / numImages));
    var actualTotal = durationPerImage * numImages;
    var fps = 25;

    console.log("Rendering: " + numImages + " images | " + actualTotal + "s | Music: " + (musicLoaded ? "yes" : "no"));

    return new Promise(function(resolve, reject) {
      var cmd = ffmpeg();

      // Add normalized images as inputs
      normalizedPaths.forEach(function(imgPath) {
        cmd = cmd.input(imgPath).inputOptions([
          "-loop 1",
          "-t " + (durationPerImage + 1),
          "-framerate " + fps
        ]);
      });

      // Add audio
      if (musicLoaded && fs.existsSync(musicPath)) {
        cmd = cmd.input(musicPath);
      } else {
        cmd = cmd.input("anullsrc=r=44100:cl=stereo").inputOptions(["-t " + actualTotal]);
      }

      var filters = [];

      // Ken Burns zoom + fade per image
      // Using normalized images so all same size - no dimension issues
      normalizedPaths.forEach(function(_, i) {
        var totalFrames = durationPerImage * fps;
        var fadeOutStart = durationPerImage - 0.6;

        var zoomFilter = "[" + i + ":v]" +
          "format=yuv420p," +
          "scale=1080:1920:force_original_aspect_ratio=increase," +
          "crop=1080:1920," +
          "setsar=1," +
          "zoompan=" +
            "z='min(zoom+0.0004,1.2)':" +
            "d=" + totalFrames + ":" +
            "x='iw/2-(iw/zoom/2)':" +
            "y='ih/2-(ih/zoom/2)':" +
            "s=1080x1920:" +
            "fps=" + fps + "," +
          "fade=t=in:st=0:d=0.6";

        if (i < normalizedPaths.length - 1) {
          zoomFilter += ",fade=t=out:st=" + fadeOutStart + ":d=0.6";
        }

        zoomFilter += "[zoomed" + i + "]";
        filters.push(zoomFilter);
      });

      // Concatenate
      var concatInput = normalizedPaths.map(function(_, i) {
        return "[zoomed" + i + "]";
      }).join("");
      filters.push(concatInput + "concat=n=" + numImages + ":v=1:a=0[base]");

      // Text overlays
      filters.push("[base]drawbox=x=0:y=0:w=iw:h=280:color=black@0.5:t=fill[topbar]");
      filters.push("[topbar]drawbox=x=0:y=1200:w=iw:h=720:color=black@0.6:t=fill[withbox]");

      var safeHook     = (hook_text || title || "").replace(/'/g, "").replace(/:/g, " ").replace(/\[/g,"").replace(/\]/g,"").substring(0, 45);
      var safeLocation = (location || "").replace(/'/g, "").replace(/:/g, " ").substring(0, 32);
      var safePrice    = (price || "") + " " + (price_unit || "");
      var safeRooms    = (bedrooms || "") + " " + (area_sqm || "");
      var safeBenefit  = (key_benefit || "").replace(/'/g, "").replace(/:/g, " ").substring(0, 40);
      var safeCta      = (cta_text || "ابعتلنا واتساب دلوقتي").replace(/'/g, "").replace(/:/g, " ").substring(0, 40);

      filters.push("[withbox]drawtext=text='" + safeHook + "':fontsize=56:fontcolor=white:x=(w-text_w)/2:y=100:shadowcolor=black@0.9:shadowx=3:shadowy=3:alpha='if(lt(t,0.2),0,if(lt(t,0.8),((t-0.2)/0.6),1))'[hook]");
      filters.push("[hook]drawtext=text='" + safeLocation + "':fontsize=34:fontcolor=#E0E0E0:x=(w-text_w)/2:y=1265:shadowcolor=black@0.8:shadowx=2:shadowy=2:alpha='if(lt(t,0.4),0,if(lt(t,1.0),((t-0.4)/0.6),1))'[loc]");
      filters.push("[loc]drawtext=text='" + safePrice + "':fontsize=52:fontcolor=#FFD700:x=(w-text_w)/2:y=1340:shadowcolor=black@0.9:shadowx=3:shadowy=3:alpha='if(lt(t,0.6),0,if(lt(t,1.2),((t-0.6)/0.6),1))'[price]");
      filters.push("[price]drawtext=text='" + safeRooms + "':fontsize=32:fontcolor=#CCCCCC:x=(w-text_w)/2:y=1420:shadowcolor=black@0.7:shadowx=2:shadowy=2:alpha='if(lt(t,0.8),0,if(lt(t,1.4),((t-0.8)/0.6),1))'[rooms]");

      var afterRooms = "rooms";
      if (safeBenefit.length > 0) {
        filters.push("[rooms]drawtext=text='" + safeBenefit + "':fontsize=30:fontcolor=#90EE90:x=(w-text_w)/2:y=1470:shadowcolor=black@0.7:shadowx=1:shadowy=1:alpha='if(lt(t,1.0),0,if(lt(t,1.5),((t-1.0)/0.5),1))'[benefit]");
        afterRooms = "benefit";
      }

      filters.push("[" + afterRooms + "]drawbox=x=(w-500)/2:y=1530:w=500:h=2:color=white@0.4:t=fill[divider]");
      filters.push("[divider]drawbox=x=(w-620)/2:y=1565:w=620:h=90:color=#25D366@0.92:t=fill[ctabg]");
      filters.push("[ctabg]drawtext=text='" + safeCta + "':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=1588:shadowcolor=black@0.3:shadowx=1:shadowy=1:alpha='if(lt(t,1.0),0,if(lt(t,1.6),((t-1.0)/0.6),1))'[final]");

      var audioIndex = normalizedPaths.length;
      var outputOptions = [
        "-map [final]",
        "-pix_fmt yuv420p",
        "-preset fast",
        "-crf 22",
        "-movflags +faststart",
        "-t " + actualTotal,
        "-c:v libx264",
        "-r " + fps,
        "-map " + audioIndex + ":a",
        "-c:a aac",
        "-b:a 128k",
        "-shortest"
      ];

      if (musicLoaded && fs.existsSync(musicPath)) {
        outputOptions.push("-af afade=t=in:st=0:d=1,afade=t=out:st=" + (actualTotal - 3) + ":d=3,volume=0.7");
      }

      cmd.complexFilter(filters)
        .outputOptions(outputOptions)
        .output(outputPath)
        .on("start", function() { console.log("FFmpeg started"); })
        .on("progress", function(p) { console.log("Progress: " + Math.round(p.percent || 0) + "%"); })
        .on("end", function() { console.log("FFmpeg complete"); resolve(); })
        .on("error", function(err, stdout, stderr) {
          console.error("FFmpeg error: " + err.message);
          if (stderr) console.error("Stderr: " + stderr.substring(0, 500));
          reject(err);
        })
        .run();
    });

  }).then(function() {
    console.log("Uploading to Drive...");
    return uploadToDrive(outputPath, fileName);

  }).then(function(result) {
    var allFiles = rawImagePaths.concat(normalizedPaths).concat([outputPath, musicPath]);
    cleanup.apply(null, allFiles);
    console.log("Done: " + result.url);
    res.json({
      success: true,
      property_id: property_id,
      video_url: result.url,
      drive_file_id: result.fileId,
      file_name: fileName,
      emotion_used: emotion,
      music: musicLoaded ? "yes" : "no",
      images_used: normalizedPaths.length
    });

  }).catch(function(error) {
    var allFiles = rawImagePaths.concat(normalizedPaths).concat([outputPath, musicPath]);
    cleanup.apply(null, allFiles);
    console.error("Fatal: " + error.message);
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


