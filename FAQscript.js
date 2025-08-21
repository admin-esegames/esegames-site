// Open the FAQ Popup
document.getElementById("faqButton").addEventListener("click", function() {
    document.getElementById("faqPopup").style.display = "flex";
});

// Close the FAQ Popup
document.querySelector(".close").addEventListener("click", function() {
    document.getElementById("faqPopup").style.display = "none";
});

// Toggle FAQ Answers
const faqItems = document.querySelectorAll(".faq-item");

faqItems.forEach(item => {
    const question = item.querySelector(".faq-question");
    const answer = item.querySelector(".faq-answer");
    const plusIcon = item.querySelector(".plus-icon");

    question.addEventListener("click", () => {
        // Close other answers and reset their plus icons
        faqItems.forEach(i => {
            if (i !== item) {
                i.querySelector(".faq-answer").classList.remove("open");
                i.querySelector(".plus-icon").textContent = "+";
            }
        });

        // Toggle the current answer
        if (answer.classList.contains("open")) {
            answer.classList.remove("open");
            plusIcon.textContent = "+";
        } else {
            answer.classList.add("open");
            plusIcon.textContent = "-";
        }
    });
});
