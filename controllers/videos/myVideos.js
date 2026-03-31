import File from "../../models/files.js";

/**
 * @Description Get all videos
 * @Route GET /api/videos/all?search=&page=1&limit=10
 * @Access Private
 */
export const getAllVideos = async (req, res) => {
    const userId = req.user?._id;
    const { search } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    try {
        let query = {
            user: userId,
            uploadType: "Videos"
        };

        if (search) {
            query["files.name"] = { $regex: search, $options: "i" };
        }

        const videos = await File.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean()
            .exec();

        const totalVideos = await File.countDocuments(query);

        return res.status(200).json({
            status: true,
            msg: "Videos fetched successfully",
            data: videos,
            totalVideos,
            page,
            limit
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}

/**
 * @Description Specific Videos
 * @Route GET /api/videos/specific/:id
 * @Access Private
 */
export const getSpecificVideo = async (req, res) => {
    const { id } = req.params;

    try {
        const video = await File.findById(id).lean().exec();
        if (!video) {
            return res.status(404).json({
                status: false,
                msg: "Video not found"
            });
        }
        return res.status(200).json({
            status: true,
            msg: "Video fetched successfully",
            data: video
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }

}


/**
 * @Description Delete Videos
 * @Route DELETE /api/videos/delete/:id
 * @Access Private
 */
export const deleteVideo = async (req, res) => {
    const { id } = req.params;

    try {
        const video = await File.findByIdAndDelete(id).lean().exec();
        if (!video) {
            return res.status(404).json({
                status: false,
                msg: "Video not found"
            });
        }
        return res.status(200).json({
            status: true,
            msg: "Video deleted successfully",
            data: video
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}