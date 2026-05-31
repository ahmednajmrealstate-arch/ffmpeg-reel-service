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

function getMusicByEmotion(emotion) {
  var musicMap = {
    "family":  process.env.MUSIC_URL_FAMILY,
    "luxury":  process.env.MUSIC_URL_LUXURY,
    "urgent":  process.env.MUSIC_URL_URGENT,
    "budget":  process.env.MUSIC_URL_BUDGET,
    "default": process.env.MUSIC_URL_DEFAULT
  };

  var selected = musicMap[emotion] || musicMap["default"] || "";

  if (!selected) {
    // Fallback: pick any available track randomly
    var allTracks = Object.values(musicMap).filter(function(u) {
      return u && u.length > 0;
    });
    if (allTracks.length > 0) {
      selected = allTracks[Math.floor(Math.random() * allTracks.length)];
    }
  }

  console.log("Emotion: " + emotion + " | Music selected: " + (selected ? "yes" : "none"));
  return selected || "";
}

function getDriveClient() {
  var auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return google.drive({ version: "v3", auth: auth });
}

function downloadFile(url, destPath) {
  return axios.get(url, {
    responseType: "stream",
    timeout: 30000,
    headers: { "User-Agent": "Mozilla/5.0" }
  }).then(function(response) {
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
    try {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    } catch(e) {
      console.log("Cleanup skip: " + f);
    }
  });
}

app.get("/health", function(req, res) {
  res.json({
    status: "ok",
    message: "FFmpeg Reel Service - Emotion Music Version",
    music_family:  process.env.MUSIC_URL_FAMILY  ? "loaded" : "missing",
    music_luxury:  process.env.MUSIC_URL_LUXURY  ? "loaded" : "missing",
    music_urgent:  process.env.MUSIC_URL_URGENT  ? "loaded" : "missing",
    music_budget:  process.env.MUSIC_URL_BUDGET  ? "loaded" : "missing",
    music_default: process.env.MUSIC_URL_DEFAULT ? "loaded" : "missing"
  });
});

app.post("/generate-reel", function(req, res) {
  var property_id  = req.body.property_id;
  var title        = req.body.title;
  var location     = req.body.location;
  var price        = req.body.price;
  var price_unit   = req.body.price_unit;
  var bedrooms     = req.body.bedrooms;
  var area_sqm     = req.body.area_sqm;
  var hook_text    = req.body.hook_text;
  var cta_text     = req.body.cta_text;
  var key_benefit  = req.body.key_benefit || "";
  var emotion      = req.body.emotion || "default";
  var image_url    = req.body.image_url;
  var secret_key   = req.body.secret_key;

  // Select music based on emotion
  var music_url = getMusicByEmotion(emotion);

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
  var musicPath = music_url ? path.join(tmpDir, property_id + "_music.mp3") : null;
  var outputPath = path.join(tmpDir, property_id + "_reel.mp4");
  var fileName = "reel_" + property_id + "_" + Date.now() + ".mp4";

  var downloadPromises = imageUrls.map(function(url, i) {
    var imgPath = path.join(tmpDir, property_id + "_img_" + i + ".jpg");
    imagePaths.push(imgPath);
    return downloadFile(url, imgPath);
  });

  if (music_url && musicPath) {
    downloadPromises.push(
      downloadFile(music_url, musicPath).catch(function(err) {
        console.log("Music download failed, continuing without: " + err.message);
        musicPath = null;
      })
    );
  }

  Promise.all(downloadPromises).then(function() {
    var numImages = imagePaths.length;
    var durationPerImage = Math.max(5, Math.floor(30 / numImages));
    var actualTotal = durationPerImage * numImages;
    var fps = 25;

    console.log("Property: " + property_id + " | Images: " + numImages + " | Emotion: " + emotion + " | Total: " + actualTotal + "s");

    return new Promise(function(resolve, reject) {
      var cmd = ffmpeg();

      imagePaths.forEach(function(imgPath) {
        cmd = cmd.input(imgPath).inputOptions([
          "-loop 1",
          "-t " + (durationPerImage + 1),
          "-framerate " + fps
        ]);
      });

      var hasMusicFile = musicPath && fs.existsSync(musicPath);
      if (hasMusicFile) {
        cmd = cmd.input(musicPath);
        console.log("Music loaded for emotion: " + emotion);
      } else {
        cmd = cmd.input("anullsrc=r=44100:cl=stereo").inputOptions(["-t " + actualTotal]);
        console.log("Silent audio fallback");
      }

      var filters = [];

      // Ken Burns zoom + fade per image
      imagePaths.forEach(function(_, i) {
        var totalFrames = durationPerImage * fps;
        var fadeOutStart = durationPerImage - 0.6;

        var zoomFilter = "[" + i + ":v]" +
          "scale=8000:-1," +
          "zoompan=" +
            "z='min(zoom+0.0004,1.2)':" +
            "d=" + totalFrames + ":" +
            "x='iw/2-(iw/zoom/2)':" +
            "y='ih/2-(ih/zoom/2)':" +
            "s=1080x1920:" +
            "fps=" + fps + "," +
          "fade=t=in:st=0:d=0.6";

        if (i < imagePaths.length - 1) {
          zoomFilter += ",fade=t=out:st=" + fadeOutStart + ":d=0.6";
        }

        zoomFilter += "[zoomed" + i + "]";
        filters.push(zoomFilter);
      });

      // Concatenate zoomed clips
      var concatInput = imagePaths.map(function(_, i) {
        return "[zoomed" + i + "]";
      }).join("");
      filters.push(concatInput + "concat=n=" + numImages + ":v=1:a=0[base]");

      // Top dark bar for hook
      filters.push(
        "[base]drawbox=" +
          "x=0:y=0:w=iw:h=280:" +
          "color=black@0.5:" +
          "t=fill" +
        "[topbar]"
      );

      // Bottom dark bar for details
      filters.push(
        "[topbar]drawbox=" +
          "x=0:y=1200:w=iw:h=720:" +
          "color=black@0.6:" +
          "t=fill" +
        "[withbox]"
      );

      // Safe text
      var safeHook       = (hook_text || title || "").replace(/'/g, "").replace(/:/g, " ").replace(/\[/g, "").replace(/\]/g, "").substring(0, 45);
      var safeLocation   = (location || "").replace(/'/g, "").replace(/:/g, " ").substring(0, 32);
      var safePrice      = (price || "") + " " + (price_unit || "");
      var safeRooms      = (bedrooms || "") + " " + (area_sqm || "");
      var safeBenefit    = (key_benefit || "").replace(/'/g, "").replace(/:/g, " ").substring(0, 40);
      var safeCta        = (cta_text || "ابعتلنا واتساب دلوقتي").replace(/'/g, "").replace(/:/g, " ").substring(0, 40);

      // Hook text top
      filters.push(
        "[withbox]drawtext=" +
          "text='" + safeHook + "':" +
          "fontsize=56:" +
          "fontcolor=white:" +
          "x=(w-text_w)/2:" +
          "y=100:" +
          "shadowcolor=black@0.9:" +
          "shadowx=3:" +
          "shadowy=3:" +
          "alpha='if(lt(t,0.2),0,if(lt(t,0.8),((t-0.2)/0.6),1))'" +
        "[hook]"
      );

      // Location
      filters.push(
        "[hook]drawtext=" +
          "text='" + safeLocation + "':" +
          "fontsize=34:" +
          "fontcolor=#E0E0E0:" +
          "x=(w-text_w)/2:" +
          "y=1265:" +
          "shadowcolor=black@0.8:" +
          "shadowx=2:" +
          "shadowy=2:" +
          "alpha='if(lt(t,0.4),0,if(lt(t,1.0),((t-0.4)/0.6),1))'" +
        "[loc]"
      );

      // Price in gold
      filters.push(
        "[loc]drawtext=" +
          "text='" + safePrice + "':" +
          "fontsize=52:" +
          "fontcolor=#FFD700:" +
          "x=(w-text_w)/2:" +
          "y=1340:" +
          "shadowcolor=black@0.9:" +
          "shadowx=3:" +
          "shadowy=3:" +
          "alpha='if(lt(t,0.6),0,if(lt(t,1.2),((t-0.6)/0.6),1))'" +
        "[price]"
      );

      // Room details
      filters.push(
        "[price]drawtext=" +
          "text='" + safeRooms + "':" +
          "fontsize=32:" +
          "fontcolor=#CCCCCC:" +
          "x=(w-text_w)/2:" +
          "y=1420:" +
          "shadowcolor=black@0.7:" +
          "shadowx=2:" +
          "shadowy=2:" +
          "alpha='if(lt(t,0.8),0,if(lt(t,1.4),((t-0.8)/0.6),1))'" +
        "[rooms]"
      );

      // Key benefit (if available)
      var afterRooms = "rooms";
      if (safeBenefit.length > 0) {
        filters.push(
          "[rooms]drawtext=" +
            "text='" + safeBenefit + "':" +
            "fontsize=30:" +
            "fontcolor=#90EE90:" +
            "x=(w-text_w)/2:" +
            "y=1470:" +
            "shadowcolor=black@0.7:" +
            "shadowx=1:" +
            "shadowy=1:" +
            "alpha='if(lt(t,1.0),0,if(lt(t,1.5),((t-1.0)/0.5),1))'" +
          "[benefit]"
        );
        afterRooms = "benefit";
      }

      // Divider line
      filters.push(
        "[" + afterRooms + "]drawbox=" +
          "x=(w-500)/2:y=1530:w=500:h=2:" +
          "color=white@0.4:" +
          "t=fill" +
        "[divider]"
      );

      // WhatsApp green button
      filters.push(
        "[divider]drawbox=" +
          "x=(w-620)/2:y=1565:w=620:h=90:" +
          "color=#25D366@0.92:" +
          "t=fill" +
        "[ctabg]"
      );

      // CTA text
      filters.push(
        "[ctabg]drawtext=" +
          "text='" + safeCta + "':" +
          "fontsize=36:" +
          "fontcolor=white:" +
          "x=(w-text_w)/2:" +
          "y=1588:" +
          "shadowcolor=black@0.3:" +
          "shadowx=1:" +
          "shadowy=1:" +
          "alpha='if(lt(t,1.0),0,if(lt(t,1.6),((t-1.0)/0.6),1))'" +
        "[final]"
      );

      // Output options
      var outputOptions = [
        "-map [final]",
        "-pix_fmt yuv420p",
        "-preset fast",
        "-crf 22",
        "-movflags +faststart",
        "-t " + actualTotal,
        "-c:v libx264",
        "-r " + fps
      ];

      var audioIndex = imagePaths.length;

      if (hasMusicFile) {
        outputOptions.push("-map " + audioIndex + ":a");
        outputOptions.push("-c:a aac");
        outputOptions.push("-b:a 128k");
        outputOptions.push("-af afade=t=in:st=0:d=1,afade=t=out:st=" + (actualTotal - 3) + ":d=3,volume=0.7");
        outputOptions.push("-shortest");
      } else {
        outputOptions.push("-map " + audioIndex + ":a");
        outputOptions.push("-c:a aac");
        outputOptions.push("-b:a 64k");
        outputOptions.push("-shortest");
      }

      cmd.complexFilter(filters)
        .outputOptions(outputOptions)
        .output(outputPath)
        .on("start", function() {
          console.log("FFmpeg rendering started");
        })
        .on("progress", function(p) {
          console.log("Progress: " + Math.round(p.percent || 0) + "%");
        })
        .on("end", function() {
          console.log("FFmpeg complete");
          resolve();
        })
        .on("error", function(err, stdout, stderr) {
          console.error("FFmpeg error: " + err.message);
          if (stderr) console.error("Stderr: " + stderr.substring(0, 500));
          reject(err);
        })
        .run();
    });

  }).then(function() {
    console.log("Uploading to Google Drive...");
    return uploadToDrive(outputPath, fileName);

  }).then(function(result) {
    var allFiles = imagePaths.concat([outputPath]);
    if (musicPath) allFiles.push(musicPath);
    cleanup.apply(null, allFiles);

    console.log("Done: " + result.url);
    res.json({
      success: true,
      property_id: property_id,
      video_url: result.url,
      drive_file_id: result.fileId,
      file_name: fileName,
      emotion_used: emotion,
      music: music_url ? "yes" : "no",
      images_used: imagePaths.length
    });

  }).catch(function(error) {
    var allFiles = imagePaths.concat([outputPath]);
    if (musicPath) allFiles.push(musicPath);
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

