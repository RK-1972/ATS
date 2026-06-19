const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({

  host: "smtp.office365.com",

  port: 587,

  secure: false,

  auth: {

    user: process.env.EMAIL_USER,

    pass: process.env.EMAIL_PASSWORD

  }

});

const sendEmail = async (

  to,
  subject,
  html

) => {

  await transporter.sendMail({

    from: process.env.EMAIL_USER,

    to,
    subject,
    html

  });

};

module.exports = sendEmail;