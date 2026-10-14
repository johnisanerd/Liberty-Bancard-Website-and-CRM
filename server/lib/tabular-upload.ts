import multer from "multer";
import os from "node:os";
import path from "node:path";

/** Intake's parser supports CSV and modern workbooks. Other bulk CSV/ZIP
 * upload policies intentionally remain separate and are not widened here. */
export const uploadTabularLarge = multer({
  dest: os.tmpdir(),
  limits: {fileSize:300*1024*1024},
  fileFilter(_req,file,cb){
    const extension=path.extname(file.originalname).toLowerCase();
    const csv=extension===".csv" &&
      ["text/csv","text/plain","application/csv","application/vnd.ms-excel"].includes(file.mimetype);
    const workbook=extension===".xlsx" &&
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel","application/octet-stream"].includes(file.mimetype);
    if(csv || workbook)return cb(null,true);
    return cb(Object.assign(new Error("Unsupported intake file type. Accepted: CSV or XLSX."),
      {status:400,code:"UNSUPPORTED_INTAKE_FILE_TYPE"}));
  },
});
