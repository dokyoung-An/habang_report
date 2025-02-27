require("dotenv").config();
const express = require("express");
const app = express();
const path = require("path");
const puppeteer = require("puppeteer"); // ✅ Puppeteer 가져오기
const multer = require("multer");
const methodOverride = require("method-override");
const { MongoClient, ObjectId } = require("mongodb");
const sharp = require("sharp");
const archiver = require("archiver");
const pdf = require("html-pdf");
const fs = require("fs-extra",'fs');
const ejs = require("ejs");


const PORT = process.env.PORT || 3000; // 환경 변수 사용


// Express 설정
app.use(express.static(path.join(__dirname, "/public")));
app.use("/css", express.static(path.join(__dirname, "public/css")));
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride("_method"));
app.use("/upload", express.static("upload"));

// ✅ .map 파일 요청 무시 (이거 추가!)
app.get("*.map", (req, res) => {
  console.warn("❌ .map 파일 요청 차단됨:", req.originalUrl);
  res.status(404).send("❌ Sourcemap 파일 없음!");
});


//monggodb 연결

const url = process.env.MONGO_URI;
const client = new MongoClient(url);

let db;
async function connectDB() {
  if (db) return db;
  try {
    await client.connect();
    console.log("✅ MongoDB 연결 성공!");
    db = client.db("Report");
    return db;
  } catch (err) {
    console.error("❌ MongoDB 연결 실패:", err);
    process.exit(1);
  }
}


module.exports = connectDB;


// ✅ Multer 파일 업로드 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "upload/");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, `${uniqueSuffix}-${sanitizedFilename}`);
  },
});

// ✅ 2. 파일 필터 (이미지 파일만 허용)
const fileFilter = (req, file, cb) => {
  const allowedExtensions = /jpeg|jpg|png|gif/;
  const extname = allowedExtensions.test(
    path.extname(file.originalname).toLowerCase()
  );
  const mimetype = allowedExtensions.test(file.mimetype);

  if (extname && mimetype) {
    return cb(null, true);
  } else {
    return cb(new Error("❌ 허용되지 않는 파일 형식입니다."), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
}).fields([
  { name: "image", maxCount: 300 }, // ✅ 기존 업로드 필드 (최대 300장 가능)
  { name: "newDefectsImages", maxCount: 2 }, // ✅ 새로운 하자 추가 시 2장까지 업로드 가능
]);





// ✅ 메인 페이지
app.get("/", (req, res) => {
  res.render("habang/index");
});

app.get("/customer", (req, res) => {
  res.render("habang/customer");
});

// 고객리스트 확인
app.get("/customer-list", async (req, res) => {
  const db = await connectDB();
  const searchQuery = req.query.search || ""; // 검색어 가져오기

  let query = {};
  if (searchQuery) {
    query.customerName = { $regex: searchQuery, $options: "i" }; // 대소문자 구분 없이 검색
  }

  // ✅ `createdAt` 기준으로 최신 데이터 정렬
  const reports = await db.collection("reports")
    .find(query)
    .sort({ createdAt: -1 }) // ✅ 최신순 정렬 (날짜 X)
    .toArray();

  console.log("📋 고객 리스트 데이터:", reports); // 콘솔에서 확인

  res.render("customer/customer-list", { reports, searchQuery });
});




// ✅ 고객 정보 등록 (보고서 ID 생성)
app.post("/register", async (req, res) => {
  const db = await connectDB();
  try {
    const reportData = {
      date: req.body.date,
      apartmentName: req.body.apart,
      dong: req.body.dong,
      home: req.body.home,
      customerName: req.body.name,
      phone: req.body.phone,
      createdAt: new Date(),
      visualInspection: [],
    };

    const result = await db.collection("reports").insertOne(reportData);
    const reportId = result.insertedId;

    console.log("✅ 새 보고서 생성 완료:", reportId);
    res.redirect(`/equipment?reportId=${reportId}`);
  } catch (err) {
    console.error("❌ 고객 정보 저장 실패:", err);
    res.status(500).json({ error: "❌ 고객 정보 저장 실패!", details: err });
  }
});

// ✅ 육안점검 보고서 등록 페이지
app.get("/inspect-registorform", (req, res) => {
  if (!req.query.reportId) {
    return res.status(400).send("❌ 유효한 reportId가 필요합니다.");
  }
  res.render("habang/inspect-registorform", { reportId: req.query.reportId });
});


// ✅ 육안점검 보고서 저장 (사진 2장 + 데이터 1개)
app.post("/report", upload, async (req, res) => {
  const db = await connectDB();

  try {
    console.log("🛠️ 요청 데이터 확인:", req.body);

    if (!req.body.reportId || !ObjectId.isValid(req.body.reportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    // ✅ 업로드된 파일 개수 확인 (Multer로 올바르게 업로드되었는지 체크)
    const uploadedFiles = req.files["image"] || []; // 업로드된 이미지 파일 리스트
    console.log("🛠️ 업로드된 파일 개수:", uploadedFiles.length);

    if (uploadedFiles.length === 0) {
      return res.status(400).json({ error: "❌ 업로드된 파일이 없습니다." });
    }

    const reportId = new ObjectId(req.body.reportId);

    // ✅ 이미지 압축 (Sharp 사용)
    for (const file of uploadedFiles) {
      const compressedPath = path.join("upload", "compressed-" + file.filename);

      await sharp(file.path)
        .resize({ width: 1024 }) // ✅ 너비 조절 (1024px)
        .jpeg({ quality: 50 })   // ✅ 품질 50%로 압축
        .toFile(compressedPath);

      // ✅ 원본 파일 삭제
      fs.unlinkSync(file.path);

      // ✅ 압축된 파일 경로로 수정
      file.path = compressedPath;
      file.filename = "compressed-" + file.filename;
    }

    

    // ✅ 입력 데이터를 배열로 변환
    const locations = Array.isArray(req.body.location)
      ? req.body.location
      : [req.body.location];
    const sectors = Array.isArray(req.body.sector)
      ? req.body.sector
      : [req.body.sector];
    const specifics = Array.isArray(req.body.specific)
      ? req.body.specific
      : [req.body.specific];
    const contents = Array.isArray(req.body.content)
      ? req.body.content
      : [req.body.content];
    const extras = Array.isArray(req.body.extra)
      ? req.body.extra
      : [req.body.extra];

    // ✅ 사진 2장 + 데이터 1개씩 그룹화하여 저장
    let visualInspectionData = [];
    let dataIndex = 0;

    for (let i = 0; i < uploadedFiles.length; i += 2) {
      let images = [uploadedFiles[i].filename];

      if (uploadedFiles[i + 1]) {
        images.push(uploadedFiles[i + 1].filename);
      }

      const entry = {
        _id: new ObjectId(), // ✅ `_id` 필드 추가
        location: locations[dataIndex] || "미입력",
        sector: sectors[dataIndex] || "미입력",
        specific: specifics[dataIndex] || "미입력",
        content: contents[dataIndex] || "미입력",
        extra: extras[dataIndex] || "미입력",
        images: images, // ✅ 2개씩 저장
        createdAt: new Date(),
      };

      visualInspectionData.push(entry);
      dataIndex++; // ✅ 데이터 인덱스 증가
    }

    console.log("🛠️ 저장할 데이터:", visualInspectionData);

    // ✅ MongoDB에 데이터 추가
    const result = await db
      .collection("reports")
      .updateOne(
        { _id: reportId },
        { $push: { visualInspection: { $each: visualInspectionData } } }
      );

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ error: "❌ 해당 reportId의 보고서를 찾을 수 없습니다." });
    }

    console.log("✅ 육안점검 데이터 저장 완료!");
    res.redirect("/customer-list");
  } catch (err) {
    console.error("❌ 서버 에러 발생:", err);
    res
      .status(500)
      .json({ error: "❌ 육안점검 저장 실패!", details: err.message });
  }
});

// ✅ 장비점검 보고서 저장
app.get("/equipment", (req, res) => {
  const reportId = req.query.reportId; // GET 요청에서 reportId 가져오기

  if (!reportId || !ObjectId.isValid(reportId)) {
    return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
  }

  res.render("habang/equipment", { reportId }); // equipment.ejs에 reportId 전달
});

// ✅ 장비점검 데이터 저장 API
app.post("/equipment-report", async (req, res) => {
  const db = await connectDB();

  try {
    const {
      reportId,
      radon,
      formaldehyde,
      equipment,
      pipeInspection,
      floor_level,
      drain_check,
    } = req.body;

    if (!reportId || !ObjectId.isValid(reportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    const reportObjectId = new ObjectId(reportId);

    // ✅ 데이터 변환 (체크박스와 입력값 정리)
    const transformArray = (data, keys) => {
      if (!Array.isArray(data)) return [];
      return data.map((item, index) => {
        let obj = { location: keys[index] };
        Object.keys(item).forEach((key) => {
          obj[key] = item[key] === "on" ? true : item[key]; // 체크박스 처리
        });
        return obj;
      });
    };

    const radonLocations = ["주방/거실", "가족욕실", "침실1(안방)"];
    const formaldehydeLocations = ["주방/거실", "가족욕실", "침실1(안방)"];
    const thermalCameraLocations = [
      "주방",
      "거실",
      "침실1(안방)",
      "침실2",
      "침실3",
      "드레스룸",
    ];
    const pipeLocations = ["가족욕실", "부부욕실", "발코니", "다용도실"];
    const floorLocations = ["거실", "침실1", "침실2", "침실3"];
    const drainLocations = ["가족욕실", "부부욕실", "발코니", "다용도실"];

    const equipmentData = {
      radon: transformArray(radon, radonLocations),
      formaldehyde: transformArray(formaldehyde, formaldehydeLocations),
      thermalCamera: transformArray(equipment, thermalCameraLocations),
      pipeInspection: transformArray(pipeInspection, pipeLocations),
      floorLevel: transformArray(floor_level, floorLocations),
      drainInspection: transformArray(drain_check, drainLocations),
      createdAt: new Date(),
    };

    // ✅ 기존 보고서에 장비점검 데이터 추가
    const result = await db
      .collection("reports")
      .updateOne(
        { _id: reportObjectId },
        { $set: { equipmentInspection: equipmentData } }
      );

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ error: "❌ 해당 reportId의 보고서를 찾을 수 없습니다." });
    }

    console.log("✅ 장비점검 데이터 저장 완료!");
    res.redirect(`/inspect-registorform?reportId=${reportId}`);
  } catch (err) {
    console.error("❌ 서버 에러 발생:", err);
    res
      .status(500)
      .json({ error: "❌ 장비점검 저장 실패!", details: err.message });
  }
});

// 고객리스트 조회
// ✅ 고객 리스트 조회
app.get("/customer-list", async (req, res) => {
  const db = await connectDB();
  try {
    const reports = await db.collection("reports").find().toArray();
    res.render("customer/customer-list", { reports });
  } catch (err) {
    res.status(500).json({ error: "❌ 고객 리스트 불러오기 실패!", details: err });
  }
});


// ✅ 보고서 상세 조회
app.get("/detail-report/:id", async (req, res) => {
  const db = await connectDB();
  try {
    const reportId = req.params.id;

    if (!ObjectId.isValid(reportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    const report = await db
      .collection("reports")
      .findOne({ _id: new ObjectId(reportId) });

    if (!report) {
      return res
        .status(404)
        .json({ error: "❌ 해당 고객의 보고서를 찾을 수 없습니다." });
    }

    // ✅ visualInspection이 없을 경우 빈 배열로 할당
    report.visualInspection = report.visualInspection || [];

    res.render("customer/report", { report });
  } catch (err) {
    res.status(500).json({ error: "❌ 보고서 조회 실패!", details: err });
  }
});

// ✅ 사전점검 수정
app.get("/edit/:id", async (req, res) => {
  const db = await connectDB();
  try {
    const reportId = req.params.id;

    if (!ObjectId.isValid(reportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }
   
    const report = await db
      .collection("reports")
      .findOne({ _id: new ObjectId(reportId) });

    if (!report) {
      return res
        .status(404)
        .json({ error: "❌ 해당 고객의 보고서를 찾을 수 없습니다." });
    }

    res.render("habang/edit", { report });
  } catch (err) {
    res.status(500).json({ error: "❌ 보고서 조회 실패!", details: err });
  }
});

// ✅ 사전점검 수정된 데이터 저장
app.post("/update-report", upload, async (req, res) => {
  const db = await connectDB();

  try {
    console.log("🛠️ 요청 데이터:", req.body);
    console.log("🛠️ 업로드된 파일:", req.files);

    if (
      !req.body.originalReportId ||
      !ObjectId.isValid(req.body.originalReportId)
    ) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    const uploadedFiles = req.files["image"] || [];


    // ✅ 이미지 압축
    for (const file of uploadedFiles) {
     const compressedPath = path.join("upload", "compressed-" + file.filename);

     await sharp(file.path)
       .resize({ width: 1024 })
       .jpeg({ quality: 50 })
       .toFile(compressedPath);

     fs.unlinkSync(file.path);
     file.path = compressedPath;
     file.filename = "compressed-" + file.filename;
   }


    const reportId = new ObjectId(req.body.originalReportId);

    // ✅ 기존 보고서 가져오기
    const existingReport = await db
      .collection("reports")
      .findOne({ _id: reportId });

    if (!existingReport) {
      return res
        .status(404)
        .json({ error: "❌ 기존 보고서를 찾을 수 없습니다!" });
    }

    // ✅ 기존 하자 데이터 유지
    let existingDefects = existingReport.visualInspection || [];

    // ✅ 기존 장비점검 데이터 유지
    let existingEquipment = existingReport.equipmentInspection || [];

    // ✅ 삭제할 기존 하자 데이터 처리
    if (req.body.removeExistingDefects) {
      let removeIds = JSON.parse(req.body.removeExistingDefects).map(
        (id) => new ObjectId(id)
      );

      console.log("🚨 삭제할 항목:", removeIds);

      // ✅ MongoDB에서 삭제
      await db
        .collection("reports")
        .updateOne(
          { _id: reportId },
          { $pull: { visualInspection: { _id: { $in: removeIds } } } }
        );

      // ✅ 기존 데이터에서 삭제된 항목 제거
      existingDefects = existingDefects.filter(
        (defect) => defect._id && !removeIds.some((id) => id.equals(defect._id))
      );

      console.log("✅ 기존 하자 삭제 완료:", removeIds);
    }

    // ✅ 새로운 하자 데이터 저장
 // ✅ 입력 데이터를 배열로 변환
const locations = Array.isArray(req.body["newDefects[][location]"])
? req.body["newDefects[][location]"]
: [req.body["newDefects[][location]"]];
const sectors = Array.isArray(req.body["newDefects[][sector]"])
? req.body["newDefects[][sector]"]
: [req.body["newDefects[][sector]"]];
const specifics = Array.isArray(req.body["newDefects[][specific]"])
? req.body["newDefects[][specific]"]
: [req.body["newDefects[][specific]"]];
const contents = Array.isArray(req.body["newDefects[][content]"])
? req.body["newDefects[][content]"]
: [req.body["newDefects[][content]"]];
const extras = Array.isArray(req.body["newDefects[][extra]"])
? req.body["newDefects[][extra]"]
: [req.body["newDefects[][extra]"]];

let newDefects = [];

locations.forEach((location, index) => {
if (!location || !sectors[index] || !specifics[index] || !contents[index]) {
  return; // 값이 없으면 건너뛰기
}

let images = [];
if (req.files && req.files["newDefectsImages"]) {
  images = req.files["newDefectsImages"]
    .slice(index * 2, index * 2 + 2)
    .map(file => file.filename);
}

const defectEntry = {
  _id: new ObjectId(),
  location: location.trim(),
  sector: sectors[index].trim(),
  specific: specifics[index].trim(),
  content: contents[index].trim(),
  extra: extras[index] ? extras[index].trim() : "",
  images: images,
  createdAt: new Date(),
};

newDefects.push(defectEntry);
});

    // ✅ 새로운 하자 추가 없이 기존 데이터만 존재하는 경우 업데이트
    const updatedVisualInspection = [...existingDefects, ...newDefects];

    await db
      .collection("reports")
      .updateOne(
        { _id: reportId },
        {
          $set: {
            visualInspection: updatedVisualInspection,
            updatedAt: new Date(),
          },
        }
      );
  

    console.log("✅ 새로운 점검 데이터 저장 완료!");
    res.redirect(`/detail-report/${reportId}`); // ✅ 저장 후 상세 페이지로 이동
  } catch (err) {
    console.error("❌ 서버 에러 발생:", err);
    res
      .status(500)
      .json({
        error: "❌ 새로운 점검 보고서 저장 실패!",
        details: err.message,
      });
  }
});

// ✅ 장비점검 데이터 조회 (수정용)
app.get("/edit-equipment/:id", async (req, res) => {
  const db = await connectDB();

  let reportId = req.params.id.trim();

  try {
    if (!ObjectId.isValid(reportId)) {
      console.error("❌ 유효하지 않은 ObjectId:", reportId);
      return res.status(400).send("❌ 유효하지 않은 ID입니다.");
    }

    const report = await db.collection("reports").findOne({ _id: new ObjectId(reportId) });

    if (!report) {
      console.error("❌ 보고서 없음:", reportId);
      return res.status(404).send("❌ 해당 보고서를 찾을 수 없습니다.");
    }

    console.log("✅ 보고서 로드 성공:", reportId);
    // ✅ 여기서 정확히 edit-equipment 뷰를 불러옵니다.
    res.render("habang/edit-equipment", { report });
  } catch (err) {
    console.error("❌ 서버 에러 발생:", err);
    res.status(500).send("❌ 서버 에러 발생");
  }
});


// ✅ 장비점검 데이터 수정 API
app.post("/update-equipment-report", async (req, res) => {
  const db = await connectDB();

  try {
    const {
      reportId,
      radon,
      formaldehyde,
      equipment,
      pipeInspection,
      floor_level,
      drain_check,
    } = req.body;

    console.log("📌 받은 reportId:", reportId); // ✅ 디버깅용

    // ✅ reportId 검증 강화
    if (!reportId || typeof reportId !== "string" || !ObjectId.isValid(reportId.trim())) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }
    
    const reportObjectId = new ObjectId(reportId.trim()); // ✅ 안전한 변환

    // ✅ MongoDB에서 해당 reportId가 존재하는지 확인
    const existingReport = await db.collection("reports").findOne({ _id: reportObjectId });

    if (!existingReport) {
      return res.status(404).json({ error: "❌ 해당 reportId의 보고서를 찾을 수 없습니다." });
    }


    // ✅ 데이터 변환 함수 (체크박스와 입력값 정리)
    const transformArray = (data, keys) => {
      if (!Array.isArray(data)) return [];
      return data.map((item, index) => {
        let obj = { location: keys[index] };
        Object.keys(item).forEach((key) => {
          obj[key] = item[key] === "on" ? true : item[key]; // 체크박스 처리
        });
        return obj;
      });
    };

    // ✅ 각 점검 항목별 위치 정의
    const radonLocations = ["주방/거실", "가족욕실", "침실1(안방)"];
    const formaldehydeLocations = ["주방/거실", "가족욕실", "침실1(안방)"];
    const thermalCameraLocations = ["주방", "거실", "침실1(안방)", "침실2", "침실3", "드레스룸"];
    const pipeLocations = ["가족욕실", "부부욕실", "발코니", "다용도실"];
    const floorLocations = ["거실", "침실1", "침실2", "침실3"];
    const drainLocations = ["가족욕실", "부부욕실", "발코니", "다용도실"];

    // ✅ 새로 변환한 장비점검 데이터
    const updatedEquipmentData = {
      radon: transformArray(radon, radonLocations),
      formaldehyde: transformArray(formaldehyde, formaldehydeLocations),
      thermalCamera: transformArray(equipment, thermalCameraLocations),
      pipeInspection: transformArray(pipeInspection, pipeLocations),
      floorLevel: transformArray(floor_level, floorLocations),
      drainInspection: transformArray(drain_check, drainLocations),
      updatedAt: new Date(),
    };

    // ✅ MongoDB에 기존 데이터 덮어쓰기
    const result = await db.collection("reports").updateOne(
      { _id: reportObjectId },
      { $set: { equipmentInspection: updatedEquipmentData } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "❌ 해당 reportId의 보고서를 찾을 수 없습니다." });
    }

    console.log("✅ 장비점검 데이터 수정 완료!");
    res.redirect(`/detail-report/${reportId}`); // ✅ 저장 후 상세 페이지로 이동
  } catch (err) {
    console.error("❌ 서버 에러 발생:", err);
    res.status(500).json({ error: "❌ 장비점검 수정 실패!", details: err.message });
  }
});




// ✅ 후점검 상세 조회
app.get("/after/:id", async (req, res) => {
  const db = await connectDB();
  try {
    const reportId = req.params.id;

    if (!ObjectId.isValid(reportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    const report = await db
      .collection("reports")
      .findOne({ _id: new ObjectId(reportId) });

    if (!report) {
      return res
        .status(404)
        .json({ error: "❌ 해당 고객의 보고서를 찾을 수 없습니다." });
    }

    res.render("habang/after", { report });
  } catch (err) {
    res.status(500).json({ error: "❌ 보고서 조회 실패!", details: err });
  }
});

// ✅ 고객 정보 수정 API
app.post("/edit-customer/:id", async (req, res) => {
  try {
    const reportId = req.params.id;
    const { customerName, phone, apartmentName, dong, home, date } = req.body;

    await db.collection("reports").updateOne(
      { _id: new ObjectId(reportId) },
      {
        $set: {
          customerName,
          phone,
          apartmentName,
          dong,
          home,
          date,
        },
      }
    );

    res.redirect(`/detail-report/${reportId}`);
  } catch (err) {
    res.status(500).send("고객 정보 수정 실패");
  }
});

// ✅ 장비 점검 수정 API
app.post("/edit-equipment/:id", async (req, res) => {
  try {
    const reportId = req.params.id;
    const equipmentData = req.body;

    await db
      .collection("reports")
      .updateOne(
        { _id: new ObjectId(reportId) },
        { $set: { equipmentInspection: equipmentData } }
      );

    res.redirect(`/detail-report/${reportId}`);
  } catch (err) {
    res.status(500).send("장비 점검 수정 실패");
  }
});

// ✅ 육안 점검 수정 페이지 (GET 요청)
app.get("/edit-inspection/:inspectionId", async (req, res) => {
  const db = await connectDB();
  try {
    const inspectionId = req.params.inspectionId;

    if (!ObjectId.isValid(inspectionId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 inspectionId!" });
    }

    // ✅ 육안 점검 데이터 검색
    const report = await db.collection("reports").findOne(
      { "visualInspection._id": new ObjectId(inspectionId) },
      { projection: { "visualInspection.$": 1 } } // ✅ 해당 하자 데이터만 가져오기
    );

    if (
      !report ||
      !report.visualInspection ||
      report.visualInspection.length === 0
    ) {
      return res
        .status(404)
        .json({ error: "❌ 해당 육안 점검 데이터를 찾을 수 없습니다." });
    }

    res.render("habang/edit", { inspection: report.visualInspection[0] });
  } catch (err) {
    res
      .status(500)
      .json({ error: "❌ 육안 점검 수정 페이지 불러오기 실패!", details: err });
  }
});

// ✅ 육안 점검 수정 API
app.post("/edit-inspection/:inspectionId", async (req, res) => {
  try {
    const inspectionId = req.params.inspectionId;
    const reportId = req.body.reportId; // 보고서 ID 필요

    await db.collection("reports").updateOne(
      { "visualInspection._id": new ObjectId(inspectionId) },
      {
        $set: {
          "visualInspection.$.location": req.body.location,
          "visualInspection.$.sector": req.body.sector,
          "visualInspection.$.specific": req.body.specific,
          "visualInspection.$.content": req.body.content,
          "visualInspection.$.extra": req.body.extra,
        },
      }
    );

    res.redirect(`/detail-report/${reportId}`);
  } catch (err) {
    res.status(500).send("육안 점검 수정 실패");
  }
});

// ✅ 육안 점검 삭제 API
app.get("/delete-inspection/:inspectionId", async (req, res) => {
  try {
    const inspectionId = req.params.inspectionId;
    const reportId = req.query.reportId; // 보고서 ID 필요

    await db
      .collection("reports")
      .updateOne(
        { _id: new ObjectId(reportId) },
        { $pull: { visualInspection: { _id: new ObjectId(inspectionId) } } }
      );

    res.redirect(`/detail-report/${reportId}`);
  } catch (err) {
    res.status(500).send("육안 점검 삭제 실패");
  }
});

//✅ PDF 다운로드 라우터 (이미지 포함)
app.get("/download-pdf/:id", async (req, res) => {
  const db = await connectDB();
  try {
    const reportId = req.params.id;

    if (!ObjectId.isValid(reportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    const report = await db
      .collection("reports")
      .findOne({ _id: new ObjectId(reportId) });

    if (!report) {
      return res
        .status(404)
        .json({ error: "❌ 해당 보고서를 찾을 수 없습니다." });
    }

    console.log(`📄 PDF 생성 시작 - 고객명: ${report.customerName}`);

    // ✅ EJS 템플릿을 HTML로 렌더링
    const templatePath = path.join(
      __dirname,
      "views",
      "customer",
      "report.ejs"
    );

    const html = await ejs.renderFile(templatePath, { report });

    // ✅ CSS 강제 적용 (HTML 내에 직접 포함)
    const styles = `
<style>
 @media print {
.nav {
display:none;
}

.customer-detail {
 display:none;
}
/*✅ 테이블 바디 스타일 */

.pdf {
    width: 100%;
    height: 97%;
    background-color: white;
    position: relative;
    box-sizing: border-box;
    display: block;
    overflow:hidden;
    
}
/* ✅ 표지 레이아웃 */

.pdf .customer h2 {
    border-bottom: none;
    border-top: 3px solid #0056b3;
    text-align: end;
    font-size: 1.8rem;
    padding-top: 0.8rem;
    
}

/* ✅ 테이블 전체 크기 및 위치 */
.pdf .customer table {
    width: 230px;
    position: absolute;
    right: -2%;
    height: auto; /* ✅ 높이를 내용에 맞게 자동 조절 */
    border-collapse: collapse; /* ✅ 테두리 겹침 제거 */
    scale: 0.6;
    top:8%;
    
}

/* ✅ 테이블 셀 공통 스타일 */
.pdf .customer table th,
.pdf .customer table td {
    font-size: 0.8rem;
    padding: 3px 10px; /* ✅ 내부 여백 조절 */
    height: 30px; /* ✅ 세로 크기 줄임 */
    vertical-align: middle; /* ✅ 세로 중앙 정렬 */
    border-color: #fff;
    box-shadow: none;
}

/* ✅ th는 왼쪽 정렬 */
.pdf .customer table th {
    text-align: left;
    width: 40%; /* ✅ th의 너비 조정 */
   
}

/* ✅ td는 가로·세로 중앙 정렬 */
.pdf .customer table td {
    text-align: center;
    
}


/* ✅ 메인 제목 중앙 정렬 */
.pdf .report {
    position: absolute;
    top: 45%;
    left: 40%;
    transform: translate(-50%, -50%);
    text-align: right;
    width: 50%;
}

.pdf .report h1 {
    font-size: 2rem;
    font-weight: bold;
}

.pdf .report p {
    font-size: 1rem;
    color: #888;
    width:100%;
    color: #888;
}

/* ✅ 배경 이미지 크기 조정 */
.pdf .bg_image img {
    width: 70%;
    position: absolute;
    bottom: 22%;
    left: 12%;
}

.pdf .image {
    position: absolute;
    bottom:1.5%;
    left: 50%;
    transform: translateX(-50%);
}
.pdf .image img{
    width: 40px;
    height: 40px;
}



 /* ✅ 페이지 나눔 방지 */
    .container, .table, .equipment-report, .inspection-report, .image-container, .report-entry {
        page-break-inside: avoid;
        break-inside: avoid;
    }

/* ✅ 표 크기 및 정렬 */
.table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 20px;
    page-break-inside: avoid;
}

.table thead th {
    background-color: #ccc;
    text-align: center;
    padding: 8px;
    font-size: 14px;
}

.table tbody td {
    text-align: center;
    padding: 6px;
    font-size: 13px;
    border: 1px solid #ddd;
    vertical-align:middle;
}

.container .table tbody td {  
   word-break:break-word;
   font-size: 13px;
    padding: 3px 6px;
    border: 1px solid #ddd;
 }

/* ✅ 표 내용 너비 조정 */
.equipment-report .table th {
    width: 25%;
}

.equipment-report .table td {
    width: 75%;
}


/* ✅ 장비점검 보고서 전체 스타일 */
.equipment-report {
    width: 100%;
    margin-top: 15px;
    page-break-before: always; /* 새 페이지에서 시작 */
}

/* ✅ 제목 스타일 */
.container h2 {
    font-size: 18px;
    font-weight: bold;
    color: #333;
    margin-bottom: 15px;
    border-bottom: 2px solid #007bff; /* 파란색 하이라이트 */
    padding-bottom: 5px;
}


/* ✅ 제목 스타일 */
.equipment-report h2 {
    font-size: 18px;
    font-weight: bold;
    color: #333;
    margin-bottom: 15px;
    border-bottom: 2px solid #007bff; /* 파란색 하이라이트 */
    padding-bottom: 5px;
}

/* ✅ 각 항목 제목 */
.equipment-report h4 {
    font-size: 16px;
    font-weight: bold;
    color: #0056b3;
    margin-top: 40px;
    border-left: 4px solid #007bff;
    padding-left: 8px;
}

/* ✅ 테이블 공통 스타일 */
.equipment-report .table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed; 
    page-break-inside: avoid; /* ✅ PDF 페이지 분리 방지 */
    
}

/* ✅ 테이블 헤더 스타일 */
.equipment-report .table thead th {
    background-color: #ccc;
    color: #000;
    font-size: 14px;
    padding: 8px;
    text-align: center;
    border: 1px solid #ddd;
}

/* ✅ 테이블 바디 스타일 */
.equipment-report .table tbody td {
    font-size: 13px;
    padding: 6px;
    text-align: center;
    border: 1px solid #ddd;
}

/* ✅ 표 내용 정렬 */
.equipment-report .table th,
.equipment-report .table td {
    text-align: center;
}

/* ✅ 표 너비 균형 조정 */
.equipment-report .table th {
    width: 25%;
}

.equipment-report .table td {
    width: 75%;
}

/* ✅ 표 내용 설명 하는 부분 */
.equipment-report .explain {
    margin: 20px 0 40px 0;
}
.equipment-report .explain-cam {
    text-align: center;
}
.equipment-report .explain li {
    list-style: square;
}

/* ✅ 육안 점검 보고서 스타일 */
/* ✅ 전체 컨테이너 */
.inspection-report{
    width: 100%;
   
}

/* ✅ 제목 스타일 */
.inspection-report h2 {
    font-size: 18px;
    font-weight: bold;
    color: #333;
    margin-bottom: 15px;
    border-bottom: 2px solid #007bff; /* 파란색 하이라이트 */
    padding-bottom: 5px;
    
}

.report-entry {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #ddd;
    margin-bottom: 15px;
    background-color: #fff;
    box-sizing: border-box;
    table-layout: fixed; /* ✅ 테이블 크기 균등 유지 */
   
}

/* ✅ 각 항목 제목 */
.inspection-report h4 {
    font-size: 16px;
    font-weight: bold;
    color: #0056b3;
    border-left: 4px solid #007bff;
    padding-left: 8px;
}

.image-container {
    padding: 10px;
    width: 100%;  /* ✅ 전체 컨테이너의 60% 차지 */
    height: 100%; /* ✅ 높이를 report-entry에 맞게 자동 조정 */
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 5px;
    overflow: hidden; /* ✅ 넘치는 부분 제거 */
}

/* ✅ 개별 이미지 - 가로 모드 강제 */
.inspection-image {
    width: 100%; /* ✅ 가로로 두 개 정렬 */
    aspect-ratio: 16 / 9; /* ✅ 강제로 가로 모드 */
    height: 100%;
    border: 1px solid #ddd;
    display: block;
    object-fit: cover; /* ✅ 비율 유지하면서 꽉 채우기 */
    object-position: center; /* ✅ 중앙 정렬 */
    max-height: 180px;
}

/* ✅ 세로로 찍힌 이미지 강제 회전 */
.inspection-image[style*="rotate"] {
    transform: rotate(0deg) !important; /* ✅ 세로 회전 제거 */
}


/* ✅ 오른쪽 정보 테이블 */
.info-section {
    padding: 5px;
    width: 40%;
    vertical-align: top; /* ✅ 위쪽 정렬 */
}

/* ✅ 정보 테이블 내부 스타일 */
.info-section .table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed; /* ✅ 균일한 크기 유지 */
    height: 100%; /* ✅ 테이블 높이 확장 */
}

/* ✅ 테이블 헤더 스타일 */
.info-section .table th {
    background-color: #ccc;
    color: #000;
    text-align: center;
    font-size: 14px; /* ✅ 글씨 키움 */
    width: 30%;
    border: 1px solid #ddd;
}



.mobile {
    display: none;
}


/* ✅ 다운로드 버튼 컨테이너 */
.download-buttons {
    display:none;

}


</style>
`;

    // ✅ PDF 생성할 HTML에 스타일 추가
    const finalHtml = styles + html;

    // ✅ PDF 옵션 설정
    const pdfOptions = {
      format: "A4",
      orientation: "portrait", // 세로 출력
      border: {
        top: "15mm",
        bottom: "15mm",
        left: "15mm",
        right: "15mm",
      },
    };

    // ✅ PDF 파일 생성
    const pdfPath = path.join(
      __dirname,
      "public",
      "pdfs",
      `report-${reportId}.pdf`
    );
    pdf.create(finalHtml, pdfOptions).toFile(pdfPath, (err, result) => {
      if (err) {
        console.error("❌ PDF 생성 실패:", err);
        return res.status(500).json({ error: "❌ PDF 생성 실패!" });
      }

      console.log("✅ PDF 저장 완료:", result.filename);
      // ✅ 파일명: 고객명 + '점검 보고서'
      const sanitizedCustomerName = report.customerName.replace(/[^a-zA-Z0-9가-힣]/g, "_"); // 특수문자 제거
      const downloadFileName = `${sanitizedCustomerName}_사전점검보고서.pdf`;

      res.download(pdfPath, downloadFileName); // ✅ 사용자 지정 파일명으로 다운로드
    });
   
  } catch (err) {
    console.error("❌ 서버 에러 발생:", err);
    res.status(500).json({ error: "❌ PDF 생성 실패!", details: err.message });
  }
});

// ✅ 이미지 다운로드 (워터마크 포함)
app.get("/download-images/:id", async (req, res) => {
  const db = await connectDB();
  try {
    const reportId = req.params.id;

    if (!ObjectId.isValid(reportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    const report = await db
      .collection("reports")
      .findOne({ _id: new ObjectId(reportId) });

    if (!report || !report.visualInspection.length) {
      return res
        .status(404)
        .json({ error: "❌ 해당 보고서의 이미지가 없습니다." });
    }

    // ✅ 다운로드 폴더 생성 (존재하지 않으면 자동 생성)
    const downloadFolder = path.join(__dirname, "public", "downloads");
    fs.ensureDirSync(downloadFolder);

    const outputPath = path.join(downloadFolder, `report-${reportId}.zip`);
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(output);

    let imageIndex = 1;

    for (const inspection of report.visualInspection) {
      for (const image of inspection.images) {
        const inputImagePath = path.join(__dirname, "upload", image);
        const outputImagePath = path.join(
          __dirname,
          "upload",
          `watermarked-${image}`
        );

        if (fs.existsSync(inputImagePath)) {
          // ✅ 원본 이미지 크기 가져오기
          const metadata = await sharp(inputImagePath).metadata();
          const width = metadata.width || 800;
          const height = metadata.height || 600;

          // ✅ 워터마크 SVG 생성 (투명한 흰색 숫자, 크기 3배)
          const fontSize = Math.floor(height / 6); // 기존보다 3배 키움
          const watermark = Buffer.from(`
            <svg width="${width}" height="${height}">
              <text x="50%" y="50%" font-size="${fontSize}" font-family="Arial"
                fill="white" opacity="0.6" text-anchor="middle" alignment-baseline="middle">
                ${imageIndex}
              </text>
            </svg>
          `);

          // ✅ 워터마크 삽입 (이미지 중앙)
          await sharp(inputImagePath)
            .composite([{ input: watermark, gravity: "center" }]) // 중앙 정렬
            .toFile(outputImagePath);

          archive.append(fs.createReadStream(outputImagePath), {
            name: `image-${imageIndex}.jpg`,
          });
          imageIndex++;
        }
      }
    }

    await archive.finalize();

    output.on("close", () => {
      res.download(outputPath, `report-${reportId}-images.zip`, () => {
        fs.unlinkSync(outputPath);
      });
    });
  } catch (err) {
    console.error("❌ 이미지 다운로드 오류:", err);
    res
      .status(500)
      .json({ error: "❌ 이미지 다운로드 실패!", details: err.message });
  }
});


//후점검 보고서  생성
app.post("/save-new-report", upload, async (req, res) => {
  const db = await connectDB();

  try {
    console.log("🛠️ 요청 데이터:", req.body);
    console.log("🛠️ 업로드된 파일:", req.files);

    if (!req.body.originalReportId || !ObjectId.isValid(req.body.originalReportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    const uploadedFiles = req.files["image"] || [];

      // ✅ 이미지 압축
      for (const file of uploadedFiles) {
        const compressedPath = path.join("upload", "compressed-" + file.filename);
  
        await sharp(file.path)
          .resize({ width: 1024 })
          .jpeg({ quality: 50 })
          .toFile(compressedPath);
  
        fs.unlinkSync(file.path);
        file.path = compressedPath;
        file.filename = "compressed-" + file.filename;
      }

    const reportId = new ObjectId(req.body.originalReportId);

    

    // ✅ 기존 보고서 가져오기
    const existingReport = await db.collection("reports").findOne({ _id: reportId });

    if (!existingReport) {
      return res.status(404).json({ error: "❌ 기존 보고서를 찾을 수 없습니다!" });
    }

    // ✅ 기존 하자 데이터 유지
    let existingDefects = existingReport.visualInspection || [];

    // ✅ 삭제할 기존 하자 데이터 처리
    if (req.body.removeExistingDefects) {
      let removeIds = JSON.parse(req.body.removeExistingDefects).map(id => new ObjectId(id));

      console.log("🚨 삭제할 항목:", removeIds);

      // ✅ MongoDB에서 해당 항목 삭제
      await db.collection("reports").updateOne(
        { _id: reportId },
        { $pull: { visualInspection: { _id: { $in: removeIds } } } }
      );

      // ✅ 기존 데이터에서 삭제된 항목 제거
      existingDefects = existingDefects.filter(
        defect => defect._id && !removeIds.some(id => id.equals(defect._id))
      );

      console.log("✅ 기존 하자 삭제 완료:", removeIds);
    }

    // ✅ 새로운 하자 데이터 저장
    let newDefects = [];
    if (req.body["newDefects[][location]"]) {
      const locations = Array.isArray(req.body["newDefects[][location]"]) ? req.body["newDefects[][location]"] : [req.body["newDefects[][location]"]];
      const sectors = Array.isArray(req.body["newDefects[][sector]"]) ? req.body["newDefects[][sector]"] : [req.body["newDefects[][sector]"]];
      const specifics = Array.isArray(req.body["newDefects[][specific]"]) ? req.body["newDefects[][specific]"] : [req.body["newDefects[][specific]"]];
      const contents = Array.isArray(req.body["newDefects[][content]"]) ? req.body["newDefects[][content]"] : [req.body["newDefects[][content]"]];
      const extras = Array.isArray(req.body["newDefects[][extra]"]) ? req.body["newDefects[][extra]"] : [req.body["newDefects[][extra]"]];

      locations.forEach((location, index) => {
        if (!location || !sectors[index] || !specifics[index] || !contents[index]) {
          return; // 값이 없으면 건너뛰기
        }

        let images = [];
        if (req.files && req.files["newDefectsImages"]) {
          images = req.files["newDefectsImages"].slice(index * 2, index * 2 + 2).map(file => file.filename);
        }

        const defectEntry = {
          _id: new ObjectId(),
          location: location.trim(),
          sector: sectors[index].trim(),
          specific: specifics[index].trim(),
          content: contents[index].trim(),
          extra: extras[index] ? extras[index].trim() : "",
          images: images,
          createdAt: new Date(),
        };

        newDefects.push(defectEntry);
      });
    }

    console.log("✅ 저장할 하자 데이터:", newDefects);

    // ✅ 새로운 후점검 보고서 객체 생성 (기존 `_id` 유지)
    let newAfterReport = {
      _id: reportId,  // 기존 보고서의 `_id`를 그대로 유지
      originalReportId: reportId, // 기존 보고서의 ID 저장
      date: req.body.date || existingReport.date,
      apartmentName: req.body.apartmentName || existingReport.apartmentName,
      dong: req.body.dong || existingReport.dong,
      home: req.body.home || existingReport.home,
      customerName: req.body.customerName || existingReport.customerName,
      phone: req.body.phone || existingReport.phone,
      visualInspection: newDefects.length > 0 ? [...existingDefects, ...newDefects] : existingDefects,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // ✅ 새로운 후점검 보고서를 `after-reports` 컬렉션에 저장
    await db.collection("after-reports").updateOne(
      { _id: reportId },  // `_id`를 기존과 동일하게 설정
      { $set: newAfterReport },
      { upsert: true }  // 없으면 새로 생성
    );

    console.log("✅ 새로운 후점검 보고서 저장 완료! ID:", reportId);

    // ✅ 기존 `_id`를 사용하여 상세 조회 페이지로 이동
    res.redirect(`/after-report/${reportId}`);

  } catch (err) {
    console.error("❌ 서버 에러 발생:", err);
    res.status(500).json({
      error: "❌ 새로운 점검 보고서 저장 실패!",
      details: err.message,
    });
  }
});




//후점검 보고서 확인
app.get("/after-report/:id", async (req, res) => {
  const db = await connectDB();

  try {
    const reportId = req.params.id;

    if (!ObjectId.isValid(reportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    // ✅ after-reports 컬렉션에서 `_id` 기준으로 조회
    const report = await db.collection("after-reports").findOne({ _id: new ObjectId(reportId) });

    if (!report) {
      console.log("❌ 해당 보고서를 찾을 수 없습니다. 조회 ID:", reportId);
      return res.status(404).json({ error: "❌ 해당 보고서를 찾을 수 없습니다." });
    }

    // ✅ visualInspection이 없을 경우 기본 배열로 설정
    report.visualInspection = report.visualInspection || [];

    // ✅ 각 inspection의 images가 undefined라면 빈 배열로 설정
    report.visualInspection.forEach(inspection => {
      inspection.images = inspection.images || [];
    });

    console.log("📋 불러온 후점검 보고서 데이터:", report);

    res.render("customer/after-report", { report });

  } catch (err) {
    console.error("❌ 서버 에러 발생:", err);
    res.status(500).json({
      error: "❌ 후점검 보고서 조회 실패!",
      details: err.message,
    });
  }
});

// ✅ 후점검 보고서 PDF 다운로드 라우터
app.get("/download-after-pdf/:id", async (req, res) => {
  const db = await connectDB();
  try {
    const reportId = req.params.id;

    if (!ObjectId.isValid(reportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    // ✅ after-reports 컬렉션에서 조회
    const report = await db
      .collection("after-reports")
      .findOne({ _id: new ObjectId(reportId) });

    if (!report) {
      return res.status(404).json({ error: "❌ 해당 보고서를 찾을 수 없습니다." });
    }

    console.log(`📄 후점검 PDF 생성 시작 - 고객명: ${report.customerName}`);

    // ✅ EJS 템플릿 경로
    const templatePath = path.join(__dirname, "views", "customer", "after-report.ejs");

    // ✅ EJS 템플릿을 HTML로 렌더링
    const html = await ejs.renderFile(templatePath, { report });

    // ✅ CSS 강제 적용 (HTML 내에 직접 포함)
       // ✅ CSS 강제 적용 (HTML 내에 직접 포함)
       const styles = `
       <style>
        @media print {
       .nav {
       display:none;
       }
       
       .customer-detail {
        display:none;
       }
       /*✅ 테이블 바디 스타일 */
       
       .pdf {
           width: 100%;
           height: 97%;
           background-color: white;
           position: relative;
           box-sizing: border-box;
           display: block;
           overflow:hidden;
           
       }
       /* ✅ 표지 레이아웃 */
       
       .pdf .customer h2 {
           border-bottom: none;
           border-top: 3px solid #0056b3;
           text-align: end;
           font-size: 1.8rem;
           padding-top: 0.8rem;
           
       }
       
       /* ✅ 테이블 전체 크기 및 위치 */
       .pdf .customer table {
           width: 230px;
           position: absolute;
           right: -2%;
           height: auto; /* ✅ 높이를 내용에 맞게 자동 조절 */
           border-collapse: collapse; /* ✅ 테두리 겹침 제거 */
           scale: 0.6;
           top:8%;
           
       }
       
       /* ✅ 테이블 셀 공통 스타일 */
       .pdf .customer table th,
       .pdf .customer table td {
           font-size: 0.8rem;
           padding: 3px 10px; /* ✅ 내부 여백 조절 */
           height: 30px; /* ✅ 세로 크기 줄임 */
           vertical-align: middle; /* ✅ 세로 중앙 정렬 */
           border-color: #fff;
           box-shadow: none;
       }
       
       /* ✅ th는 왼쪽 정렬 */
       .pdf .customer table th {
           text-align: left;
           width: 40%; /* ✅ th의 너비 조정 */
          
       }
       
       /* ✅ td는 가로·세로 중앙 정렬 */
       .pdf .customer table td {
           text-align: center;
           
       }
       
       
       /* ✅ 메인 제목 중앙 정렬 */
       .pdf .report {
           position: absolute;
           top: 45%;
           left: 40%;
           transform: translate(-50%, -50%);
           text-align: right;
           width: 50%;
       }
       
       .pdf .report h1 {
           font-size: 2rem;
           font-weight: bold;
       }
       
       .pdf .report p {
           font-size: 1rem;
           color: #888;
           width:100%;
           color: #888;
       }
       
       /* ✅ 배경 이미지 크기 조정 */
       .pdf .bg_image img {
           width: 70%;
           position: absolute;
           bottom: 22%;
           left: 12%;
       }
       
       .pdf .image {
           position: absolute;
           bottom:1.5%;
           left: 50%;
           transform: translateX(-50%);
       }
       .pdf .image img{
           width: 40px;
           height: 40px;
       }
       
       
       
        /* ✅ 페이지 나눔 방지 */
           .container, .table, .equipment-report, .inspection-report, .image-container, .report-entry {
               page-break-inside: avoid;
               break-inside: avoid;
           }
       
       /* ✅ 표 크기 및 정렬 */
       .table {
           width: 100%;
           border-collapse: collapse;
           margin-bottom: 20px;
           page-break-inside: avoid;
          
       }
       
       .table thead th {
           background-color: #ccc;
           text-align: center;
           padding: 8px;
           font-size: 14px;
       }
       
   
       /* ✅ 제목 스타일 */
       .container h2 {
           font-size: 18px;
           font-weight: bold;
           color: #333;
           margin-bottom: 15px;
           border-bottom: 2px solid #007bff; /* 파란색 하이라이트 */
           padding-bottom: 5px;
       }
       
       
       /* ✅ 테이블 바디 스타일 */
     .container .table tbody td {  
       word-break:break-word;
       font-size: 13px;
       padding: 3px 6px;
       border: 1px solid #ddd;
       vertical-align:middle;
 }}
       
       
       /* ✅ 육안 점검 보고서 스타일 */
       /* ✅ 전체 컨테이너 */
       .inspection-report{
           margin-top: 50px;
           width: 100%;
          
       }
       
       /* ✅ 제목 스타일 */
       .inspection-report h2 {
           font-size: 18px;
           font-weight: bold;
           color: #333;
           margin-bottom: 15px;
           border-bottom: 2px solid #007bff; /* 파란색 하이라이트 */
           padding-bottom: 5px;
           
       }
       
       .report-entry {
           width: 100%;
           border-collapse: collapse;
           border: 1px solid #ddd;
           margin-bottom: 15px;
           background-color: #fff;
           box-sizing: border-box;
           table-layout: fixed; /* ✅ 테이블 크기 균등 유지 */
          
       }
       
       /* ✅ 각 항목 제목 */
       .inspection-report h4 {
           font-size: 16px;
           font-weight: bold;
           color: #0056b3;
           margin-top: 15px;
           border-left: 4px solid #007bff;
           padding-left: 8px;
       }
       
       .image-container {
           padding: 10px;
           width: 100%;  /* ✅ 전체 컨테이너의 60% 차지 */
           height: 100%; /* ✅ 높이를 report-entry에 맞게 자동 조정 */
           display: flex;
           justify-content: space-between;
           align-items: center;
           gap: 5px;
           overflow: hidden; /* ✅ 넘치는 부분 제거 */
       }
       
       /* ✅ 개별 이미지 - 가로 모드 강제 */
       .inspection-image {
           width: 100%; /* ✅ 가로로 두 개 정렬 */
           aspect-ratio: 16 / 9; /* ✅ 강제로 가로 모드 */
           height: 100%;
           border: 1px solid #ddd;
           display: block;
           object-fit: cover; /* ✅ 비율 유지하면서 꽉 채우기 */
           object-position: center; /* ✅ 중앙 정렬 */
           max-height: 180px;
       }
       
       /* ✅ 세로로 찍힌 이미지 강제 회전 */
       .inspection-image[style*="rotate"] {
           transform: rotate(0deg) !important; /* ✅ 세로 회전 제거 */
       }
       
       
       /* ✅ 오른쪽 정보 테이블 */
       .info-section {
           padding: 10px;
           width: 40%;
           vertical-align: top; /* ✅ 위쪽 정렬 */
       }
       
       /* ✅ 정보 테이블 내부 스타일 */
       .info-section .table {
           width: 100%;
           border-collapse: collapse;
           table-layout: fixed; /* ✅ 균일한 크기 유지 */
           height: 100%; /* ✅ 테이블 높이 확장 */
       }
       
       /* ✅ 테이블 헤더 스타일 */
       .info-section .table th {
           background-color: #ccc;
           color: #000;
           text-align: center;
           font-size: 14px; /* ✅ 글씨 키움 */
           padding: 8px;
           width: 30%;
           border: 1px solid #ddd;
       }
       
       .mobile {
           display: none;
       }
       
       
       /* ✅ 다운로드 버튼 컨테이너 */
       .download-buttons {
           display:none;
       
       }
       
       
       </style>
       `;
       

    // ✅ PDF 생성할 HTML에 스타일 추가
    const finalHtml = styles + html;

    // ✅ PDF 옵션 설정
    const pdfOptions = {
      format: "A4",
      orientation: "portrait",
      border: {
        top: "15mm",
        bottom: "15mm",
        left: "15mm",
        right: "15mm",
      },
    };

    // ✅ PDF 파일 경로
    const pdfPath = path.join(__dirname, "public", "pdfs", `after-report-${reportId}.pdf`);

    // ✅ PDF 파일 생성
    pdf.create(finalHtml, pdfOptions).toFile(pdfPath, (err, result) => {
      if (err) {
        console.error("❌ 후점검 PDF 생성 실패:", err);
        return res.status(500).json({ error: "❌ 후점검 PDF 생성 실패!" });
      }

      console.log("✅ 후점검 PDF 저장 완료:", result.filename);
       // ✅ 파일명: 고객명 + '점검 보고서'
       const sanitizedCustomerName = report.customerName.replace(/[^a-zA-Z0-9가-힣]/g, "_"); // 특수문자 제거
       const downloadFileName = `${sanitizedCustomerName}_후점검보고서.pdf`;
 
       res.download(pdfPath, downloadFileName); // ✅ 사용자 지정 파일명으로 다운로드
    });
  } catch (err) {
    console.error("❌ 서버 에러 발생:", err);
    res.status(500).json({ error: "❌ 후점검 PDF 생성 실패!", details: err.message });
  }
});




// ✅ 후점검 보고서 존재 여부 확인 API
app.get("/after-report-check/:id", async (req, res) => {
  const db = await connectDB();
  try {
    const reportId = req.params.id;

    console.log("📌 API 요청됨: /after-report-check/" + reportId);

    if (!ObjectId.isValid(reportId)) {
      console.log("❌ 유효하지 않은 reportId:", reportId);
      return res.status(400).json({ exists: false, error: "❌ 유효하지 않은 reportId!" });
    }

    // ✅ `after-reports` 컬렉션에서 해당 보고서 조회
    const report = await db.collection("after-reports").findOne({ _id: new ObjectId(reportId) });

      // ✅ `visualInspection`이 없을 경우 빈 배열로 설정
      report.visualInspection = report.visualInspection || [];

      // ✅ `images` 필드가 없는 경우 빈 배열로 초기화
      report.visualInspection = report.visualInspection.map(defect => ({
        ...defect,
        images: Array.isArray(defect.images) ? defect.images : []
      }));

    if (report) {
      console.log("✅ 후점검 보고서 존재:", reportId);
      return res.json({ exists: true });
    } else {
      console.log("❌ 후점검 보고서 없음:", reportId);
      return res.json({ exists: false });
    }
  } catch (err) {
    console.error("❌ 후점검 보고서 확인 중 오류 발생:", err);
    return res.status(500).json({ exists: false, error: "❌ 서버 오류 발생!" });
  }
});



// ✅ 후점검 보고서 수정
app.post("/update-after-report", upload, async (req, res) => {
  const db = await connectDB();

  try {
    console.log("🛠️ 요청 데이터:", req.body);
    console.log("🛠️ 업로드된 파일:", req.files);

    if (!req.body.originalReportId || !ObjectId.isValid(req.body.originalReportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    const uploadedFiles = req.files["image"] || [];

    // ✅ 이미지 압축
    for (const file of uploadedFiles) {
     const compressedPath = path.join("upload", "compressed-" + file.filename);

     await sharp(file.path)
       .resize({ width: 1024 })
       .jpeg({ quality: 50 })
       .toFile(compressedPath);

     fs.unlinkSync(file.path);
     file.path = compressedPath;
     file.filename = "compressed-" + file.filename;
   }

    const reportId = new ObjectId(req.body.originalReportId);

    // ✅ 기존 후점검 보고서 가져오기
    let existingReport = await db.collection("after-reports").findOne({ _id: reportId });

    if (!existingReport) {
      return res.status(404).json({ error: "❌ 기존 후점검 보고서를 찾을 수 없습니다!" });
    }

    // ✅ 기존 하자 데이터 유지
    let existingDefects = existingReport.visualInspection || [];

    // ✅ 삭제할 기존 하자 데이터 처리
    if (req.body.removeExistingDefects) {
      let removeIds = JSON.parse(req.body.removeExistingDefects).map(id => new ObjectId(id));

      console.log("🚨 삭제할 항목:", removeIds);

      // ✅ MongoDB에서 삭제
      await db.collection("after-reports").updateOne(
        { _id: reportId },
        { $pull: { visualInspection: { _id: { $in: removeIds } } } }
      );

      // ✅ 기존 데이터에서 삭제된 항목 제거
      existingDefects = existingDefects.filter(defect => defect._id && !removeIds.some(id => id.equals(defect._id)));

      console.log("✅ 기존 하자 삭제 완료:", removeIds);
    }

    // ✅ 새로운 하자 데이터 저장
    let newDefects = [];
    if (req.body["newDefects[][location]"]) {
      const locations = Array.isArray(req.body["newDefects[][location]"]) ? req.body["newDefects[][location]"] : [req.body["newDefects[][location]"]];
      const sectors = Array.isArray(req.body["newDefects[][sector]"]) ? req.body["newDefects[][sector]"] : [req.body["newDefects[][sector]"]];
      const specifics = Array.isArray(req.body["newDefects[][specific]"]) ? req.body["newDefects[][specific]"] : [req.body["newDefects[][specific]"]];
      const contents = Array.isArray(req.body["newDefects[][content]"]) ? req.body["newDefects[][content]"] : [req.body["newDefects[][content]"]];
      const extras = Array.isArray(req.body["newDefects[][extra]"]) ? req.body["newDefects[][extra]"] : [req.body["newDefects[][extra]"]];

      locations.forEach((location, index) => {
        if (!location || !sectors[index] || !specifics[index] || !contents[index]) {
          return; // 값이 없으면 건너뛰기
        }

        let images = [];
        if (req.files && req.files["newDefectsImages"]) {
          images = req.files["newDefectsImages"].slice(index * 2, index * 2 + 2).map(file => file.filename);
        }

        const defectEntry = {
          _id: new ObjectId(),
          location: location.trim(),
          sector: sectors[index].trim(),
          specific: specifics[index].trim(),
          content: contents[index].trim(),
          extra: extras[index] ? extras[index].trim() : "",
          images: images.length > 0 ? images : [], // ✅ 빈 배열 처리
          createdAt: new Date(),
        };

        newDefects.push(defectEntry);
      });
    }

    console.log("✅ 저장할 하자 데이터:", newDefects);

    // ✅ 기존 데이터 유지 & 새로운 데이터 추가
    const updatedVisualInspection = [...existingDefects, ...newDefects];

    await db.collection("after-reports").updateOne(
      { _id: reportId },
      {
        $set: {
          visualInspection: updatedVisualInspection,
          updatedAt: new Date(),
        },
      }
    );

    console.log("✅ 새로운 후점검 보고서 저장 완료!");
    res.redirect(`/after-report/${reportId}`); // ✅ 저장 후 상세 페이지로 이동
  } catch (err) {
    console.error("❌ 서버 에러 발생:", err);
    res.status(500).json({ error: "❌ 후점검 보고서 저장 실패!", details: err.message });
  }
});

// ✅ 후점검 이미지 다운로드 (워터마크 포함)
app.get("/download-after-images/:id", async (req, res) => {
  const db = await connectDB();
  try {
    const reportId = req.params.id;

    // ✅ 유효한 ObjectId인지 확인
    if (!ObjectId.isValid(reportId)) {
      return res.status(400).json({ error: "❌ 유효하지 않은 reportId!" });
    }

    // ✅ after-reports 컬렉션에서 후점검 보고서 가져오기
    const report = await db.collection("after-reports").findOne({ _id: new ObjectId(reportId) });

    if (!report || !report.visualInspection.length) {
      return res.status(404).json({ error: "❌ 해당 후점검 보고서의 이미지가 없습니다." });
    }

    // ✅ 다운로드 폴더 생성 (존재하지 않으면 생성)
    const downloadFolder = path.join(__dirname, "public", "downloads");
    fs.ensureDirSync(downloadFolder);

    const outputPath = path.join(downloadFolder, `after-report-${reportId}.zip`);
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(output);

    let imageIndex = 1;

    // ✅ 이미지에 워터마크 추가 후 압축
    for (const inspection of report.visualInspection) {
      for (const image of inspection.images) {
        const inputImagePath = path.join(__dirname, "upload", image);
        const outputImagePath = path.join(__dirname, "upload", `watermarked-${image}`);

        if (fs.existsSync(inputImagePath)) {
          // ✅ 이미지 메타데이터 가져오기
          const metadata = await sharp(inputImagePath).metadata();
          const width = metadata.width || 800;
          const height = metadata.height || 600;

          // ✅ 워터마크 SVG 생성
          const fontSize = Math.floor(height / 6); // 이미지 크기에 비례
          const watermark = Buffer.from(`
            <svg width="${width}" height="${height}">
              <text x="50%" y="50%" font-size="${fontSize}" font-family="Arial"
                fill="white" opacity="0.6" text-anchor="middle" alignment-baseline="middle">
                ${imageIndex}
              </text>
            </svg>
          `);

          // ✅ 워터마크 삽입
          await sharp(inputImagePath)
            .composite([{ input: watermark, gravity: "center" }])
            .toFile(outputImagePath);

          // ✅ 압축 파일에 이미지 추가
          archive.append(fs.createReadStream(outputImagePath), {
            name: `after-image-${imageIndex}.jpg`,
          });
          imageIndex++;
        }
      }
    }

    await archive.finalize();

    // ✅ 압축 완료 후 다운로드
    output.on("close", () => {
      res.download(outputPath, `after-report-${reportId}-images.zip`, () => {
        fs.unlinkSync(outputPath); // 다운로드 후 zip 파일 삭제
      });
    });
  } catch (err) {
    console.error("❌ 이미지 다운로드 오류:", err);
    res.status(500).json({ error: "❌ 이미지 다운로드 실패!", details: err.message });
  }
});





// ✅ MongoDB 연결 후 서버 실행
connectDB().then(() => {
  app.listen(PORT, () => console.log(`✅ 서버 실행: http://localhost:${PORT}`));
});
