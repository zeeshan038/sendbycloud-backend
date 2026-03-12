import Joi from "joi";


//Register Schema
export const RegisterSchema = (payload) => {
    const schema = Joi.object({
        name: Joi.string().required().messages({
            "string.empty": "Name is required",
            "any.required": "Name is required",
        }),
        email: Joi.string().required().messages({
            "string.empty": "Email is required",
            "any.required": "Email is required",
        }),
        password: Joi.string().required().messages({
            "string.empty": "Password is required",
            "any.required": "Password is required",
        })
    }).unknown(false);
    const validationResult = schema.validate(payload);
    return validationResult;
};

//Login Schema
export const LoginSchema = (payload) => {
    const schema = Joi.object({
       email: Joi.string().required().messages({
            "string.empty": "Email is required",
            "any.required": "Email is required",
        }),
        password: Joi.string().required().messages({
            "string.empty": "Password is required",
            "any.required": "Password is required",
        })

    }).unknown(false);

    const validationResult = schema.validate(payload);
    return validationResult;
}