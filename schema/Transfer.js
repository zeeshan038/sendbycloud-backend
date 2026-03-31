import Joi from "joi";

export const TransferSchema = (payload) => {
    const schema = Joi.object({
        senderEmail: Joi.string().email().optional().allow("", null).messages({
            "string.email": "Invalid sender email format",
        }),
        recevierEmails: Joi.array().items(Joi.string().email()).optional().allow(null).messages({
            "string.email": "Invalid email in receiver list",
        }),
        files: Joi.array().items(Joi.alternatives().try(Joi.string(), Joi.object())).min(1).optional().messages({
            "array.min": "At least one file is required",
        }),
        totalSize: Joi.number().required(),
        message: Joi.string().allow("", null),
        uploadType: Joi.string().valid("File", "Folder", "Videos").default("File"),
        password: Joi.string().allow("", null),
        expireDate: Joi.date().iso().allow(null),
        downloadLimit: Joi.number().integer().min(1).allow(null),
        expireIn: Joi.string().valid(
            "1d", "3d", "7d", "14d", "30d", "unlimited", 
            "1 Day", "2 Days", "3 Days", "4 Days", "5 Days", "6 Days", "7 Days", 
            "1 Month", "2 Months", "3 Months", "4 Months", "5 Months", "6 Months", 
            "1 Year", "2 Years", "3 Years", "4 Years", "5 Years", "6 Years", "7 Years", "8 Years", "9 Years", "10 Years"
        ).default("7d"),
        background: Joi.string().allow("", null),
        backgroundType: Joi.string().allow("", null),
        backgroundLink: Joi.string().uri().allow("", null),
        selfDestruct: Joi.boolean().default(false),
        user: Joi.string().allow(null),
        verificationToken: Joi.string().allow("", null).optional()
    }).unknown(true);

    return schema.validate(payload);
};

export const VerifyPasswordSchema = (payload) => {
    const schema = Joi.object({
        password: Joi.string().required().messages({
            "string.empty": "Password is required",
            "any.required": "Password is required",
        })
    });
    return schema.validate(payload);
};
