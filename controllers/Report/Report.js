import Report from "../../models/Report.js";

/**
 * @Description Create Report
 * @Route POST /api/report/create
 * @Access Private
 */
export const createReport = async (req, res) => {
    const { category, name, email, company, subject, message } = req.body;
    try {
        const report = new Report({
            category,
            name,
            email,
            company,
            subject,
            message
        });
        await report.save();
        return res.status(201).json({
            status: true,
            msg: "Report created successfully",
            data: report
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}

/**
 * @Description Get All Reports
 * @Route GET /api/report/all
 * @Access Private
 */
export const getAllReports = async (req, res) => {
    const { id } = req.user;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    try {
        const reports = await Report.find({ user: id }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec();
        return res.status(200).json({
            status: true,
            msg: "Reports fetched successfully",
            data: reports
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}